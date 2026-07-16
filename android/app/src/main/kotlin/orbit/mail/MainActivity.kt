package orbit.mail

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import orbit.ui.compose.ComposeViewModel
import orbit.ui.compose.InboxViewModel
import orbit.ui.compose.OrbitApp
import orbit.ui.compose.OrbitTheme
import orbit.ui.compose.ReaderViewModel

/**
 * The single Activity host. Pulls the [AppGraph] off the Application, constructs
 * the three ViewModels over the shared [orbit.ui.compose.MailUiRepository], and
 * renders the Compose UI (Step 5). This is the top of the composition.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val graph = (application as OrbitApplication).graph
        val repo = graph.mailUiRepository

        setContent {
            OrbitTheme {
                // Primary account (send-from default) + self-addresses (reply-all
                // dedup), resolved reactively from the stored accounts.
                val accounts by graph.accountsSnapshot.collectAsState(
                    initial = AccountsSnapshot(primaryAccountId = "", selfAddresses = emptySet())
                )
                val inboxVm: InboxViewModel = viewModel(
                    factory = viewModelFactory { initializer { InboxViewModel(repo).also { it.observe("unified") } } }
                )
                val readerVm: ReaderViewModel = viewModel(
                    factory = viewModelFactory { initializer { ReaderViewModel(repo) } }
                )
                val composeVm: ComposeViewModel = viewModel(
                    factory = viewModelFactory { initializer { ComposeViewModel(repo) } }
                )
                OrbitApp(
                    inboxVm = inboxVm,
                    readerVm = readerVm,
                    composeVm = composeVm,
                    accountId = accounts.primaryAccountId,
                    selfAddresses = accounts.selfAddresses,
                    nowMs = System.currentTimeMillis(),
                )
            }
        }
    }
}
