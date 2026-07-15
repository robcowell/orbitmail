package orbit.data

import androidx.room.TypeConverter

/** Room converters mapping the domain enums to/from their exact wire strings. */
class Converters {
    @TypeConverter fun providerToWire(p: Provider): String = p.wire
    @TypeConverter fun providerFromWire(v: String): Provider = Provider.from(v)

    @TypeConverter fun folderTypeToWire(t: FolderType): String = t.wire
    @TypeConverter fun folderTypeFromWire(v: String): FolderType = FolderType.from(v)

    @TypeConverter fun flagColorToWire(c: FlagColor?): String? = c?.wire
    @TypeConverter fun flagColorFromWire(v: String?): FlagColor? = v?.let { FlagColor.from(it) }

    @TypeConverter fun priorityToWire(p: AiPriority): String = p.wire
    @TypeConverter fun priorityFromWire(v: String): AiPriority = AiPriority.from(v)

    @TypeConverter fun statusToWire(s: TaskStatus): String = s.wire
    @TypeConverter fun statusFromWire(v: String): TaskStatus = TaskStatus.from(v)
}
