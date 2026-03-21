import SwiftUI

struct RootView: View {
    @ObservedObject var sessionRepository: SessionRepository

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Text("Example iOS Mobile")
                    .font(.title2)
                NavigationLink("Open WebView Login") {
                    WebViewScreen(sessionRepository: sessionRepository)
                }
            }
            .padding()
        }
    }
}
