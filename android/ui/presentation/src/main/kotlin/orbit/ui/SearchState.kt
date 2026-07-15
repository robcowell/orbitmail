package orbit.ui

/**
 * Search bar state + the scope-aware LIKE pattern the Step 2 MessageDao consumes.
 * `buildLikePattern` mirrors the desktop `buildLikePattern` so local search
 * behaves identically (space → wildcard, so tokens may appear in order).
 */
data class SearchState(
    val query: String = "",
    val field: SearchField = SearchField.ALL
) {
    val canSearch: Boolean get() = query.isNotBlank()

    companion object {
        /** `foo bar` → `%foo%bar%` over sanitized input. */
        fun buildLikePattern(query: String): String {
            val sanitized = query.trim().replace(Regex("[^\\w@.\\s]"), "").replace(Regex("\\s+"), " ").trim()
            if (sanitized.isEmpty()) return "%"
            return "%" + sanitized.replace(" ", "%") + "%"
        }
    }
}
