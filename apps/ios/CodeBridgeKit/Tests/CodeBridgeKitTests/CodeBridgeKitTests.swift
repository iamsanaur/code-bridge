import Foundation
import Testing
@testable import CodeBridgeKit

@Suite struct TerminalBufferTests {
    @Test func carriageReturnOverwrites() {
        var t = TerminalBuffer()
        t.write("downloading 10%\rdownloading 100%\ndone\n")
        #expect(t.plainText() == "downloading 100%\ndone\n")
    }

    @Test func sgrColours() {
        var t = TerminalBuffer()
        t.write("\u{1B}[1;32mPASS\u{1B}[0m test")
        #expect(t.allLines()[0] == [TermSegment(text: "PASS", style: TermStyle(fg: 2, bold: true)), TermSegment(text: " test", style: TermStyle())])
    }

    @Test func splitEscapes() {
        var t = TerminalBuffer()
        t.write("a\u{1B}[3")
        t.write("1mred\u{1B}[0m")
        #expect(t.plainText() == "ared")
        #expect(t.allLines()[0][1].style.fg == 1)
    }

    @Test func oscAndErase() { #expect(stripAnsi("\u{1B}]0;title\u{07}hello\u{1B}[2K\rbye") == "bye") }

    @Test func capsLines() {
        var t = TerminalBuffer(maxLines: 3)
        t.write("1\n2\n3\n4\n5\n")
        #expect(t.allLines().count == 4)
        #expect(t.dropped == 2)
    }
}

@Suite struct SessionStateTests {
    func out(_ seq: Int, _ d: String) -> SequencedEvent { SequencedEvent(sessionId: "s", seq: seq, event: .output(stream: "pty", data: d)) }

    @Test func ordersAndDeduplicates() {
        var s = SessionState()
        #expect(s.apply(out(1, "a")) == .applied)
        #expect(s.apply(out(3, "c")) == .gap)
        #expect(s.apply(out(1, "a")) == .duplicate)
        s.apply(out(2, "b"))
        #expect(s.terminal.plainText() == "abc")
        #expect(s.lastSeq == 3)
    }

    @Test func resumesAfterGap() {
        var s = SessionState()
        s.apply(out(10, "late"))
        s.resume(from: 10)
        #expect(s.lastSeq == 10)
        #expect(s.terminal.plainText().hasSuffix("late"))
    }

    @Test func chatTranscript() {
        var s = SessionState()
        s.apply(SequencedEvent(sessionId: "s", seq: 1, event: .userPrompt("fix")))
        s.apply(SequencedEvent(sessionId: "s", seq: 2, event: .agentText("Look")))
        s.apply(SequencedEvent(sessionId: "s", seq: 3, event: .agentText("ing")))
        s.apply(SequencedEvent(sessionId: "s", seq: 4, event: .toolCall(toolUseId: "t", name: "read_file", summary: "{}")))
        s.apply(SequencedEvent(sessionId: "s", seq: 5, event: .toolResult(toolUseId: "t", ok: true, summary: "ok")))
        #expect(s.chat[1] == .assistant(id: "2", text: "Looking", streaming: false))
        #expect(s.chat[2] == .tool(id: "4", toolUseId: "t", name: "read_file", summary: "{}", result: ToolOutcome(ok: true, summary: "ok")))
    }
}

@Suite struct ProtocolTests {
    @Test func parsesFrames() {
        let ev = ServerMessage.parse(Data(#"{"type":"event","sessionId":"s1","seq":4,"ts":"t","event":{"kind":"status","status":"completed","exitCode":0}}"#.utf8))
        #expect(ev == .event(SequencedEvent(sessionId: "s1", seq: 4, ts: "t", event: .status(.completed, exitCode: 0, message: nil))))
        let ack = ServerMessage.parse(Data(#"{"type":"command.ack","commandId":"c","ok":false,"error":{"code":"duplicate","message":"x"}}"#.utf8))
        #expect(ack == .commandAck(commandId: "c", ok: false, error: CommandError(code: "duplicate", message: "x")))
        #expect(ServerMessage.parse(Data(#"{"type":"replay.gap","sessionId":"s","resumeFromSeq":7}"#.utf8)) == .replayGap(sessionId: "s", resumeFromSeq: 7))
    }

    @Test func rejectsUnknown() {
        #expect(ServerMessage.parse(Data("{nope".utf8)) == nil)
        #expect(ServerMessage.parse(Data(#"{"type":"event","sessionId":"s","seq":1,"ts":"","event":{"kind":"future.kind"}}"#.utf8)) == nil)
    }

    @Test func decodesDevice() throws {
        let json = #"{"id":"d","name":"Mac","hostname":null,"platform":"darwin","agentVersion":"0.1.0","online":true,"lastSeenAt":null,"createdAt":"2026-01-01T00:00:00.000Z","capabilities":null,"workspaces":[],"presets":[],"extra":1}"#
        let d = try JSONDecoder().decode(Device.self, from: Data(json.utf8))
        #expect(d.online && d.hostname == nil)
    }
}

@Suite struct UtilTests {
    @Test func args() {
        #expect(splitArgs("npm run test -- --watch=false") == ["npm", "run", "test", "--", "--watch=false"])
        #expect(splitArgs(#"git commit -m "fix: a b" ''"#) == ["git", "commit", "-m", "fix: a b", ""])
    }

    @Test func pairing() {
        #expect(codeFromQR("codebridge://pair?code=ABCD-EFGH&server=https%3A%2F%2Fx") == "ABCDEFGH")
        #expect(codeFromQR("https://evil.example/pair?code=ABCD-EFGH") == nil)
        #expect(normalizePairingCode("ABCD-EFG0") == nil)
    }
}

@Suite struct ConnectLinkTests {
    @Test func roundTripsAwkwardCharacters() throws {
        let link = makeConnectLink(server: URL(string: "https://my-relay.fly.dev")!, secret: "a+b/c=d&e")
        let parsed = try #require(parseConnectLink(link))
        #expect(parsed.server.absoluteString == "https://my-relay.fly.dev")
        #expect(parsed.secret == "a+b/c=d&e")
        #expect(parsed.host == "my-relay.fly.dev")
    }

    @Test func acceptsLocalHttpOnly() {
        #expect(parseConnectLink("codebridge://connect?server=http%3A%2F%2Flocalhost%3A8080&secret=s") != nil)
        #expect(parseConnectLink("codebridge://connect?server=http%3A%2F%2Fexample.com&secret=s") == nil)
    }

    @Test func rejectsEverythingElse() {
        #expect(parseConnectLink("https://x.dev") == nil)
        #expect(parseConnectLink("codebridge://pair?code=ABCD-EFGH") == nil)
        #expect(parseConnectLink("codebridge://connect?server=https%3A%2F%2Fx.dev") == nil)
        #expect(parseConnectLink("codebridge://connect?server=https%3A%2F%2Fx.dev&secret=") == nil)
        #expect(parseConnectLink("nope") == nil)
    }

    @Test func toleratesWhitespaceAndTrailingSlash() {
        #expect(parseConnectLink("  codebridge://connect?server=https%3A%2F%2Fx.dev%2F&secret=s\n")?.server.absoluteString == "https://x.dev")
    }

    @Test func relayStoreRoundTrips() async {
        let store = InMemoryRelayStore()
        let r = RelayConnection(server: URL(string: "https://x.dev")!, secret: "s")
        await store.save(r)
        #expect(await store.load() == r)
        await store.clear()
        #expect(await store.load() == nil)
    }
}

@Suite struct ProjectNameTests {
    @Test func acceptsOrdinaryNames() {
        for n in ["my-app", "App 2", "v1.2_final", "a", "  tidy  "] { #expect(isValidProjectName(n), "\(n)") }
    }

    @Test func rejectsPathsAndOddNames() {
        for n in ["", "   ", "../escape", "a/b", "a\\b", "/etc", ".hidden", "..", "trailing.", "two..dots", "-dash",
                  String(repeating: "a", count: 65), "semi;colon", "$(whoami)", "émoji🙂", "line\nbreak"] {
            #expect(!isValidProjectName(n), "\(n)")
        }
    }

    @Test func explainsTheProblem() {
        #expect(projectNameError("a/b") != nil)
        #expect(projectNameError("") == nil) // nothing typed yet
        #expect(projectNameError("fine") == nil)
    }

    @Test func decodesCapabilitiesFromOldAndNewAgents() throws {
        let old = #"{"pty":true,"anthropicKeyConfigured":false,"claudeCodeAvailable":true,"allowCustomCommands":false,"allowInteractiveShell":false}"#
        let new = #"{"pty":true,"anthropicKeyConfigured":false,"claudeCodeAvailable":true,"allowCustomCommands":false,"allowInteractiveShell":false,"canCreateWorkspaces":true}"#
        #expect(try JSONDecoder().decode(Capabilities.self, from: Data(old.utf8)).canCreateWorkspaces == nil)
        #expect(try JSONDecoder().decode(Capabilities.self, from: Data(new.utf8)).canCreateWorkspaces == true)
    }

    @Test func decodesTheCreateResult() throws {
        let json = #"{"workspace":{"id":"ws_1","name":"p","displayPath":"~/CodeBridge/p","isGitRepo":true},"gitInit":true}"#
        let r = try JSONDecoder().decode(CreateWorkspaceResult.self, from: Data(json.utf8))
        #expect(r.workspace.name == "p" && r.gitInit)
    }
}
