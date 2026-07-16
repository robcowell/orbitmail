package orbit.ui.compose

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import orbit.ui.ComposeDraft

/**
 * App shell + navigation covering the four flows from the plan's Step 5:
 * inbox list → thread reader → compose/send, plus search. ViewModels are created
 * per the app's DI; drafts flow reader → composer via the nav's saved-state
 * handle in the real app (sketched here as a shared holder).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OrbitApp(
    inboxVm: InboxViewModel,
    readerVm: ReaderViewModel,
    composeVm: ComposeViewModel,
    accountId: String,
    selfAddresses: Set<String>,
    nowMs: Long,
    nav: NavHostController = rememberNavController(),
) {
    fun openCompose(draft: ComposeDraft) { composeVm.start(draft); nav.navigate(Route.COMPOSE) }

    NavHost(nav, startDestination = Route.INBOX) {
        composable(Route.INBOX) {
            Scaffold(
                topBar = {
                    TopAppBar(
                        title = { Text("All Inboxes") },
                        actions = { IconButton(onClick = { nav.navigate(Route.SEARCH) }) { Icon(Icons.Filled.Search, "Search") } },
                    )
                },
                floatingActionButton = {
                    FloatingActionButton(onClick = { openCompose(ComposeDraft()) }) { Icon(Icons.Filled.Edit, "Compose") }
                },
            ) { pad ->
                InboxListScreen(
                    vm = inboxVm,
                    nowMs = nowMs,
                    onOpen = { row -> row.threadId?.let { readerVm.openThread(row.accountId, it); nav.navigate(Route.READER) } },
                    modifier = Modifier.padding(pad),
                )
            }
        }
        composable(Route.READER) {
            ThreadReaderScreen(readerVm, nowMs, selfAddresses, onCompose = ::openCompose)
        }
        composable(Route.COMPOSE) {
            ComposeScreen(composeVm, accountId, onSent = { nav.popBackStack() })
        }
        composable(Route.SEARCH) {
            // A full search screen reuses InboxListScreen over search results;
            // omitted here for brevity — the query→results path is the same
            // MailUiRepository.search + MessageRow rendering.
            Text("Search")
        }
    }
}

object Route {
    const val INBOX = "inbox"
    const val READER = "reader"
    const val COMPOSE = "compose"
    const val SEARCH = "search"
}
