package dev.codebridge.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TerminalBufferTest {
    @Test fun carriageReturnOverwrites() {
        val t = TerminalBuffer()
        t.write("downloading 10%\rdownloading 100%\ndone\n")
        assertEquals("downloading 100%\ndone\n", t.plainText())
    }

    @Test fun sgrColoursBecomeSegments() {
        val t = TerminalBuffer()
        t.write("\u001b[1;32mPASS\u001b[0m test")
        assertEquals(listOf(TermSegment("PASS", TermStyle(2, true)), TermSegment(" test", TermStyle(-1, false))), t.lines()[0])
    }

    @Test fun escapesSplitAcrossChunks() {
        val t = TerminalBuffer()
        t.write("a\u001b[3")
        t.write("1mred\u001b[0m")
        assertEquals("ared", t.plainText())
        assertEquals(1, t.lines()[0][1].style.fg)
    }

    @Test fun oscIgnoredAndEraseLine() = assertEquals("bye", stripAnsi("\u001b]0;title\u0007hello\u001b[2K\rbye"))

    @Test fun capsLines() {
        val t = TerminalBuffer(3)
        t.write("1\n2\n3\n4\n5\n")
        assertEquals(4, t.lines().size)
        assertEquals(2, t.dropped)
    }

    @Test fun tabsAndBackspace() {
        assertEquals("ab      c", stripAnsi("ab\tc"))
        assertEquals("aXc", stripAnsi("abc\b\bX"))
    }
}

class SessionStateTest {
    private fun ev(seq: Int, e: SessionEvent) = SequencedEvent("s", seq, "", e)
    private fun out(seq: Int, d: String) = ev(seq, SessionEvent.Output("pty", d))

    @Test fun ordersAndDeduplicates() {
        val s = SessionState()
        assertEquals(ApplyResult.APPLIED, s.apply(out(1, "a")))
        assertEquals(ApplyResult.GAP, s.apply(out(3, "c")))
        assertEquals(ApplyResult.DUPLICATE, s.apply(out(1, "a")))
        assertEquals("a", s.terminal.plainText())
        s.apply(out(2, "b"))
        assertEquals("abc", s.terminal.plainText())
        assertEquals(3, s.lastSeq)
    }

    @Test fun resumesAfterPermanentGap() {
        val s = SessionState()
        s.apply(out(10, "late"))
        s.resumeFrom(10)
        assertEquals(10, s.lastSeq)
        assertTrue(s.terminal.plainText().contains("no longer available"))
        assertTrue(s.terminal.plainText().endsWith("late"))
    }

    @Test fun buildsChatTranscript() {
        val s = SessionState()
        s.apply(ev(1, SessionEvent.UserPrompt("fix it")))
        s.apply(ev(2, SessionEvent.AgentText("Look")))
        s.apply(ev(3, SessionEvent.AgentText("ing")))
        s.apply(ev(4, SessionEvent.ToolCall("t1", "read_file", "{}")))
        s.apply(ev(5, SessionEvent.ToolResult("t1", true, "Read a")))
        s.apply(ev(6, SessionEvent.Error("rate_limited", "slow down", true)))
        assertEquals(listOf("UserMessage", "Assistant", "Tool", "Failure"), s.chat.map { it::class.simpleName })
        assertEquals(ChatItem.Assistant("2", "Looking", false), s.chat[1])
        assertEquals(ToolOutcome(true, "Read a"), (s.chat[2] as ChatItem.Tool).result)
    }

    @Test fun tracksApprovalsAndStatus() {
        val s = SessionState()
        s.apply(ev(1, SessionEvent.ApprovalRequest("a1", "write_file", "Create x", "…", "medium", "")))
        s.apply(ev(2, SessionEvent.Status(SessionStatus.WAITING)))
        assertEquals(1, s.approvals.size)
        s.apply(ev(3, SessionEvent.ApprovalResolved("a1", "approved")))
        s.apply(ev(4, SessionEvent.Status(SessionStatus.COMPLETED, exitCode = 0)))
        assertEquals(0, s.approvals.size)
        assertEquals(0, s.exitCode)
        assertEquals(StatusGroup.COMPLETED, s.status!!.group)
    }
}

class ProtocolTest {
    @Test fun parsesServerFrames() {
        val e = ServerMessage.parse("""{"type":"event","sessionId":"s1","seq":4,"ts":"t","event":{"kind":"status","status":"completed","exitCode":0}}""")
        assertIs<ServerMessage.Event>(e)
        assertEquals(SessionEvent.Status(SessionStatus.COMPLETED, exitCode = 0), e.event.event)
        val ack = ServerMessage.parse("""{"type":"command.ack","commandId":"c","ok":false,"error":{"code":"duplicate","message":"x"}}""")
        assertEquals(ServerMessage.CommandAck("c", false, CommandError("duplicate", "x")), ack)
        assertEquals(ServerMessage.DeviceStatus("d", false, null), ServerMessage.parse("""{"type":"device.status","deviceId":"d","online":false,"lastSeenAt":null}"""))
        assertEquals(ServerMessage.ReplayGap("s", 7), ServerMessage.parse("""{"type":"replay.gap","sessionId":"s","resumeFromSeq":7}"""))
    }

    @Test fun rejectsGarbageAndUnknownKinds() {
        assertNull(ServerMessage.parse("{nope"))
        assertNull(ServerMessage.parse("""{"type":"event","sessionId":"s","seq":1,"ts":"","event":{"kind":"future.kind"}}"""))
        assertNull(ServerMessage.parse("""{"type":"something.new"}"""))
    }

    @Test fun decodesUsageAndApprovalEvents() {
        val u = ServerMessage.parse(
            """{"type":"event","sessionId":"s","seq":2,"ts":"","event":{"kind":"usage","usage":{"model":"claude-opus-5-5","inputTokens":10,"outputTokens":5,"cacheReadTokens":0,"cacheWriteTokens":0,"estimatedCostUsd":null,"source":"anthropic_usage"}}}""",
        ) as ServerMessage.Event
        assertNull((u.event.event as SessionEvent.UsageUpdate).usage.estimatedCostUsd)
    }
}

class UtilTest {
    @Test fun splitsArgsWithoutShellSemantics() {
        assertEquals(listOf("npm", "run", "test", "--", "--watch=false"), splitArgs("npm run test -- --watch=false"))
        assertEquals(listOf("git", "commit", "-m", "fix: a b", ""), splitArgs("git commit -m \"fix: a b\" ''"))
        assertEquals(listOf("echo", "\$(whoami)", "|", "cat"), splitArgs("echo \$(whoami) | cat"))
    }

    @Test fun parsesPairingLinksOnly() {
        assertEquals("ABCDEFGH", codeFromQr("codebridge://pair?code=ABCD-EFGH&server=https%3A%2F%2Fx"))
        assertNull(codeFromQr("https://evil.example/pair?code=ABCD-EFGH"))
        assertNull(codeFromQr("codebridge://pair?code=nope"))
        assertNull(normalizePairingCode("ABCD-EFG0"))
        assertEquals("ABCDEFGH", normalizePairingCode("abcd efgh"))
    }

    @Test fun backoffIsCapped() {
        assertEquals(499, backoffDelayMs(0) { 0.999 })
        assertTrue(backoffDelayMs(40) { 0.999 } <= 15_000)
    }
}

class ConnectLinkTest {
    @Test fun roundTripsAwkwardCharacters() {
        val link = makeConnectLink("https://my-relay.fly.dev/", "a+b/c=d&e")
        val parsed = parseConnectLink(link)!!
        assertEquals("https://my-relay.fly.dev", parsed.server)
        assertEquals("a+b/c=d&e", parsed.secret)
        assertEquals("my-relay.fly.dev", parsed.host)
    }

    @Test fun acceptsLocalHttpOnlyIncludingTheEmulatorHost() {
        assertNotNull(parseConnectLink("codebridge://connect?server=http%3A%2F%2F10.0.2.2%3A8080&secret=s"))
        assertNotNull(parseConnectLink("codebridge://connect?server=http%3A%2F%2Flocalhost%3A8080&secret=s"))
        assertNull(parseConnectLink("codebridge://connect?server=http%3A%2F%2Fexample.com&secret=s"))
    }

    @Test fun rejectsEverythingElse() {
        assertNull(parseConnectLink("https://x.dev"))
        assertNull(parseConnectLink("codebridge://pair?code=ABCD-EFGH"))
        assertNull(parseConnectLink("codebridge://connect?server=https%3A%2F%2Fx.dev"))
        assertNull(parseConnectLink("codebridge://connect?server=https%3A%2F%2Fx.dev&secret="))
        assertNull(parseConnectLink("nope"))
    }

    @Test fun toleratesWhitespaceAndTrailingSlash() {
        assertEquals("https://x.dev", parseConnectLink("  codebridge://connect?server=https%3A%2F%2Fx.dev%2F&secret=s\n")?.server)
    }
}

class ProjectNameTest {
    @Test fun acceptsOrdinaryNames() {
        listOf("my-app", "App 2", "v1.2_final", "a", "  tidy  ").forEach { assertTrue(isValidProjectName(it), it) }
    }

    @Test fun rejectsPathsAndOddNames() {
        listOf(
            "", "   ", "../escape", "a/b", "a\\b", "/etc", ".hidden", "..", "trailing.", "two..dots", "-dash",
            "a".repeat(65), "semi;colon", "\$(whoami)", "émoji🙂", "line\nbreak",
        ).forEach { assertFalse(isValidProjectName(it), it) }
    }

    @Test fun explainsTheProblem() {
        assertNotNull(projectNameError("a/b"))
        assertNull(projectNameError(""))
        assertNull(projectNameError("fine"))
    }

    @Test fun decodesCapabilitiesFromOldAndNewAgents() {
        val old = """{"pty":true,"anthropicKeyConfigured":false,"claudeCodeAvailable":true,"allowCustomCommands":false,"allowInteractiveShell":false}"""
        val new = old.dropLast(1) + ""","canCreateWorkspaces":true}"""
        assertNull(ProtocolJson.decodeFromString(Capabilities.serializer(), old).canCreateWorkspaces)
        assertEquals(true, ProtocolJson.decodeFromString(Capabilities.serializer(), new).canCreateWorkspaces)
    }

    @Test fun decodesTheCreateResult() {
        val json = """{"workspace":{"id":"ws_1","name":"p","displayPath":"~/CodeBridge/p","isGitRepo":true},"gitInit":true}"""
        val r = ProtocolJson.decodeFromString(CreateWorkspaceResult.serializer(), json)
        assertEquals("p", r.workspace.name)
        assertTrue(r.gitInit)
    }
}

class ToolDisplayTest {
    @kotlin.test.Test fun headlinePicksTheCommand() {
        kotlin.test.assertEquals("npm test", ToolDisplay.headline("""{"command":"npm test","description":"Run tests"}"""))
        kotlin.test.assertEquals("/a/b.ts", ToolDisplay.headline("""{"file_path":"/a/b.ts","old_string":"x"}"""))
        kotlin.test.assertNull(ToolDisplay.headline("{}"))
    }

    @kotlin.test.Test fun resultUnwrapsAndPreviews() {
        val wrapped = """[{"type":"text","text":"one\ntwo\nthree\nfour\nfive"}]"""
        kotlin.test.assertEquals(listOf("one", "two", "three"), ToolDisplay.preview(wrapped).first)
        kotlin.test.assertEquals(2, ToolDisplay.preview(wrapped).second)
        kotlin.test.assertEquals(0, ToolDisplay.preview("plain").second)
    }

    @kotlin.test.Test fun editBecomesRedAndGreenLines() {
        val d = ToolDisplay.diff("""{"file_path":"/a.ts","old_string":"a\nb","new_string":"c"}""")!!
        kotlin.test.assertEquals("/a.ts", d.path)
        kotlin.test.assertEquals(listOf(false, false, true), d.lines.map { it.added })
        kotlin.test.assertNull(ToolDisplay.diff("""{"command":"ls"}"""))
        kotlin.test.assertNull(ToolDisplay.diff("""{"file_path":"/a.ts","old_string":"truncat"""))
    }
}

class MessageBlocksTest {
    @kotlin.test.Test fun splitsProseAndCode() {
        val b = MessageBlocks.split("Run it:\n```sh\ncd app\n./build.sh\n```\nThen look.")
        kotlin.test.assertEquals(listOf(false, true, false), b.map { it.code })
        kotlin.test.assertEquals("cd app\n./build.sh", b[1].text)
    }

    @kotlin.test.Test fun anOpenFenceIsCodeToTheEnd() {
        val b = MessageBlocks.split("a\n```\nx = 1")
        kotlin.test.assertEquals(listOf(false, true), b.map { it.code })
        kotlin.test.assertEquals(1, MessageBlocks.split("no code here").size)
    }
}
