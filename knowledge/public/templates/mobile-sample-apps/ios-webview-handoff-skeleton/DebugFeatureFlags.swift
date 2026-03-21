import Foundation

enum DebugFeatureFlags {
    static var kyberionHandoffEnabled: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }
}
