package com.cloudfuze.chatcleaner.microsoft;

/**
 * Microsoft Graph <strong>Application</strong> permissions (client-credentials / {@code .default} scope)
 * required by the Teams cleaner. Configure in Azure Portal → App registration → API permissions
 * → <strong>Application permissions</strong> for Microsoft Graph → <strong>Grant admin consent for the tenant</strong>.
 *
 * <p>Token request uses {@code https://graph.microsoft.com/.default}, which includes all consented application roles.</p>
 * <ul>
 * <li>{@code User.Read.All} — {@code GET /users} (enumerate users for per-user chat discovery)</li>
 * <li>{@code Group.Read.All} — {@code GET /groups} with Team filter (list teams)</li>
 * <li>{@code Group.ReadWrite.All} — {@code DELETE /groups/{id}} (delete teams)</li>
 * <li>{@code Chat.Read.All} — {@code GET /users/{id}/chats}, {@code GET /chats/{id}/messages}</li>
 * <li>{@code Chat.ReadWrite.All} — message soft-delete in delete flow</li>
 * </ul>
 */
public final class TeamsGraphApplicationPermissions {

    private TeamsGraphApplicationPermissions() {}

    public static final String USER_READ_ALL = "User.Read.All";
    public static final String GROUP_READ_ALL = "Group.Read.All";
    public static final String GROUP_READ_WRITE_ALL = "Group.ReadWrite.All";
    public static final String CHAT_READ_ALL = "Chat.Read.All";
    public static final String CHAT_READ_WRITE_ALL = "Chat.ReadWrite.All";

    /** Minimum set for preview (list teams + users + chats + read messages for last-activity enrichment). */
    public static final String[] REQUIRED_FOR_FETCH_AND_PREVIEW = {
            USER_READ_ALL,
            GROUP_READ_ALL,
            CHAT_READ_ALL
    };

    /** Add for deleting teams and soft-deleting chat messages. */
    public static final String[] ADDITIONAL_FOR_DELETE = {
            GROUP_READ_WRITE_ALL,
            CHAT_READ_WRITE_ALL
    };
}
