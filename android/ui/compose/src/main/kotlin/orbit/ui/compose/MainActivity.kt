package orbit.ui.compose

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge

/**
 * The single Activity host. ViewModels + the MailUiRepository (Room + sync +
 * SMTP + AppAuth) are provided by the app's DI graph; wiring is sketched here.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            OrbitTheme {
                // val repo = appGraph.mailUiRepository
                // OrbitApp(
                //     inboxVm = viewModel { InboxViewModel(repo).also { it.observe(currentFolderId) } },
                //     readerVm = viewModel { ReaderViewModel(repo) },
                //     composeVm = viewModel { ComposeViewModel(repo) },
                //     accountId = currentAccountId,
                //     selfAddresses = accountEmails,
                //     nowMs = System.currentTimeMillis(),
                // )
            }
        }
    }
}
