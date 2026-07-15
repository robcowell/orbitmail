package orbit.ui.compose

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.StarBorder
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import orbit.ui.MailFormat
import orbit.ui.MessageRow

/**
 * Inbox list. Rows are keyed by id so Compose recomposes minimally on the
 * reactive Room refresh (the "reference-preserving refresh" of audit §Performance
 * is handled by stable keys here). Star toggles optimistically via the ViewModel.
 */
@Composable
fun InboxListScreen(
    vm: InboxViewModel,
    nowMs: Long,
    onOpen: (MessageRow) -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    LazyColumn(modifier.fillMaxSize()) {
        items(state.visibleRows, key = { it.id }) { row ->
            MessageRowItem(
                row = row,
                nowMs = nowMs,
                onClick = { vm.select(row.id); onOpen(row) },
                onToggleStar = { vm.toggleStar(row.id, !row.isStarred) },
            )
            HorizontalDivider()
        }
    }
}

@Composable
private fun MessageRowItem(row: MessageRow, nowMs: Long, onClick: () -> Unit, onToggleStar: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp)) {
        Column(Modifier.weight(1f)) {
            val weight = if (row.isRead) FontWeight.Normal else FontWeight.Bold
            Row(Modifier.fillMaxWidth()) {
                Text(MailFormat.senderDisplayName(row.from), fontWeight = weight, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(MailFormat.listDate(row.date, nowMs), style = MaterialTheme.typography.labelSmall)
            }
            Text(row.subject.ifBlank { "(No subject)" }, fontWeight = weight, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(row.snippet, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        IconButton(onClick = onToggleStar) {
            if (row.isStarred) Icon(Icons.Filled.Star, contentDescription = "Unstar")
            else Icon(Icons.Outlined.StarBorder, contentDescription = "Star")
        }
    }
}
