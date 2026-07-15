package orbit.data

/**
 * Domain enums for the discriminated string columns. Each carries its exact
 * on-disk `wire` value so the stored schema matches the audited contract
 * (verified in ../schema-verify) rather than Kotlin's default enum name.
 */

enum class Provider(val wire: String) {
    GMAIL("gmail"), O365("o365"), IMAP("imap"), POP3("pop3");
    companion object { fun from(v: String) = entries.first { it.wire == v } }
}

enum class FolderType(val wire: String) {
    INBOX("inbox"), SENT("sent"), DRAFTS("drafts"), TRASH("trash"), JUNK("junk"), CUSTOM("custom");
    companion object { fun from(v: String) = entries.first { it.wire == v } }
}

enum class FlagColor(val wire: String) {
    RED("red"), ORANGE("orange"), YELLOW("yellow"), GREEN("green"),
    BLUE("blue"), PURPLE("purple"), GRAY("gray");
    companion object { fun from(v: String) = entries.first { it.wire == v } }
}

enum class AiPriority(val wire: String) {
    URGENT("urgent"), HIGH("high"), MEDIUM("medium"), LOW("low");
    companion object { fun from(v: String) = entries.first { it.wire == v } }
}

enum class TaskStatus(val wire: String) {
    OPEN("open"), COMPLETED("completed");
    companion object { fun from(v: String) = entries.first { it.wire == v } }
}

/** Local search scope (UI-facing; not stored on message rows). */
enum class SearchField { ALL, FROM, TO, SUBJECT, BODY }
