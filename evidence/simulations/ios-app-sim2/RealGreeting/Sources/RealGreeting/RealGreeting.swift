import Foundation

public struct GreetingLogic {
    public init() {}

    public func greet(name: String, isPremium: Bool) -> String {
        if isPremium {
            return "【VIP】こんにちは、\(name)様。いつもありがとうございます。"
        } else {
            return "こんにちは、\(name)さん。"
        }
    }
}