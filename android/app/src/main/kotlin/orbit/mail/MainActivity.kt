package orbit.mail

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
 * renders the Compose UI (Step 5). Shows onboarding until an account exists.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val graph = (application as OrbitApplication).graph
        val repo = graph.mailUiRepository

        setContent {
            OrbitTheme {
                // null = accounts not loaded yet; then decide onboarding vs inbox.
                val accounts by graph.accountsSnapshot.collectAsState(initial = null)

                // ViewModels are created unconditionally (Compose rule); the inbox
                // observes the unified view regardless of the current account.
                val inboxVm: InboxViewModel = viewModel(
                    factory = viewModelFactory { initializer { InboxViewModel(repo).also { it.observe("unified") } } }
                )
                val readerVm: ReaderViewModel = viewModel(
                    factory = viewModelFactory { initializer { ReaderViewModel(repo) } }
                )
                val composeVm: ComposeViewModel = viewModel(
                    factory = viewModelFactory { initializer { ComposeViewModel(repo) } }
                )

                val snapshot = accounts
                when {
                    snapshot == null ->
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }

                    snapshot.primaryAccountId.isBlank() ->
                        AddAccountScreen(graph)

                    else ->
                        OrbitApp(
                            inboxVm = inboxVm,
                            readerVm = readerVm,
                            composeVm = composeVm,
                            accountId = snapshot.primaryAccountId,
                            selfAddresses = snapshot.selfAddresses,
                            nowMs = System.currentTimeMillis(),
                        )
                }
            }
        }
    }
}
