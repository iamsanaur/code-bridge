import Testing
@testable import CodeBridgeKit

@Suite struct ToolDisplayTests {
    @Test func headlinePicksTheCommand() {
        #expect(ToolDisplay.headline(summary: #"{"command":"npm test","description":"Run tests"}"#) == "npm test")
        #expect(ToolDisplay.headline(summary: #"{"file_path":"/a/b.ts","old_string":"x"}"#) == "/a/b.ts")
    }

    @Test func headlineFlattensAndClips() {
        let long = String(repeating: "a", count: 200)
        let h = ToolDisplay.headline(summary: "{\"command\":\"echo 1\\necho 2\"}")
        #expect(h == "echo 1 echo 2")
        #expect(ToolDisplay.headline(summary: "{\"command\":\"\(long)\"}")!.count == 90)
        #expect(ToolDisplay.headline(summary: "{}") == nil)
    }

    @Test func resultUnwrapsTextBlocksAndPreviews() {
        let wrapped = #"[{"type":"text","text":"one\ntwo\nthree\nfour\nfive"}]"#
        #expect(ToolDisplay.resultText(wrapped) == "one\ntwo\nthree\nfour\nfive")
        let p = ToolDisplay.preview(wrapped)
        #expect(p.lines == ["one", "two", "three"])
        #expect(p.more == 2)
        #expect(ToolDisplay.preview("plain").more == 0)
    }

    @Test func editBecomesRedAndGreenLines() {
        let d = ToolDisplay.diff(name: "Edit", summary: #"{"file_path":"/a.ts","old_string":"a\nb","new_string":"c"}"#)
        #expect(d?.path == "/a.ts")
        #expect(d?.lines == [.init(kind: .removed, text: "a"), .init(kind: .removed, text: "b"), .init(kind: .added, text: "c")])
        #expect(ToolDisplay.diff(name: "Bash", summary: #"{"command":"ls"}"#) == nil)
        #expect(ToolDisplay.diff(name: "Edit", summary: #"{"file_path":"/a.ts","old_string":"truncat"#) == nil)
    }
}

@Suite struct MessageBlocksTests {
    @Test func splitsProseAndCode() {
        let text = "Run it:\n```sh\ncd app\n./build.sh\n```\nThen look."
        #expect(MessageBlocks.split(text) == [
            .init(code: false, text: "Run it:"),
            .init(code: true, text: "cd app\n./build.sh"),
            .init(code: false, text: "Then look."),
        ])
    }

    @Test func anOpenFenceIsCodeToTheEnd() {
        #expect(MessageBlocks.split("a\n```\nx = 1") == [.init(code: false, text: "a"), .init(code: true, text: "x = 1")])
        #expect(MessageBlocks.split("no code here") == [.init(code: false, text: "no code here")])
    }
}
