import XCTest
@testable import RealGreeting

final class RealGreetingTests: XCTestCase {
    func testPremiumGreeting() throws {
        let logic = GreetingLogic()
        // 期待値: プレミアムユーザーには特別な挨拶
        XCTAssertEqual(logic.greet(name: "Alice", isPremium: true), "【VIP】こんにちは、Alice様。いつもありがとうございます。")
    }

    func testStandardGreeting() throws {
        let logic = GreetingLogic()
        XCTAssertEqual(logic.greet(name: "Bob", isPremium: false), "こんにちは、Bobさん。")
    }
}