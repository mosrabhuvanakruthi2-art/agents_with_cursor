package com.cloudfuze.chatcleaner.service;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriUtils;

import com.cloudfuze.chatcleaner.microsoft.TeamsGraphApplicationPermissions;

import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

/**
 * Microsoft Teams + chats via Graph. Required application permissions: see
 * {@link TeamsGraphApplicationPermissions}.
 */
@Service
public class MicrosoftTeamsService {

    private static final Logger log = LoggerFactory.getLogger(MicrosoftTeamsService.class);
    private static final String GRAPH = "https://graph.microsoft.com/v1.0";

    private final RestTemplate restTemplate;

    @Value("${microsoft.teams.chat-user-scan-limit:2000}")
    private int chatUserScanLimit;

    /** Fetch newest message timestamp per chat so date-range matches real messaging (needs {@link TeamsGraphApplicationPermissions#CHAT_READ_ALL}). */
    @Value("${microsoft.teams.enrich-chat-last-message:true}")
    private boolean enrichChatLastMessage;

    /** When set (e.g. erik@filefuze.co), DM/chat discovery uses only this user — GET /users/{id}/chats. Empty = scan all users in tenant (up to chat-user-scan-limit). */
    @Value("${microsoft.admin.email:}")
    private String microsoftAdminEmail;

    public MicrosoftTeamsService(@Qualifier("teamsRestTemplate") RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    public List<SpaceDto> listAll(Consumer<String> onProgress) {
        return listAll(onProgress, null, null);
    }

    /** Fetch teams + chats using the selected date window (Graph side filter when possible). */
    public List<SpaceDto> listAll(Consumer<String> onProgress, LocalDate start, LocalDate end) {
        CompletableFuture<List<SpaceDto>> teamsFuture = CompletableFuture.supplyAsync(() -> listAllTeams(onProgress));
        CompletableFuture<List<SpaceDto>> chatsFuture = CompletableFuture.supplyAsync(() -> listAllChats(onProgress, start, end));
        List<SpaceDto> all = new ArrayList<>();
        all.addAll(teamsFuture.join());
        all.addAll(chatsFuture.join());
        long teams = all.stream().filter(s -> "SPACE".equals(s.getSpaceType())).count();
        long chats = all.size() - teams;
        onProgress.accept("Total found: " + teams + " teams, " + chats + " chats/DMs");
        return all;
    }

    public List<SpaceDto> listAllTeams(Consumer<String> onProgress) {
        List<SpaceDto> result = new ArrayList<>();
        onProgress.accept("Fetching Teams from Microsoft Graph...");

        // ConsistencyLevel: eventual + $count=true required for resourceProvisioningOptions filter
        HttpHeaders headers = new HttpHeaders();
        headers.set("ConsistencyLevel", "eventual");
        HttpEntity<Void> entity = new HttpEntity<>(headers);

        String url = GRAPH + "/groups?$filter=resourceProvisioningOptions/Any(x:x%20eq%20'Team')"
                + "&$select=id,displayName,createdDateTime,renewedDateTime,description&$top=100&$count=true";
        do {
            try {
                log.info("Teams: GET {}", url);
                ResponseEntity<GroupsResponse> resp = restTemplate.exchange(URI.create(url), HttpMethod.GET, entity, GroupsResponse.class);
                GroupsResponse body = resp.getBody();
                if (body == null || body.getValue() == null) {
                    log.warn("Teams: empty response body");
                    break;
                }
                log.info("Teams: page returned {} groups", body.getValue().size());
                for (GroupDto g : body.getValue()) {
                    SpaceDto dto = new SpaceDto();
                    dto.setName("groups/" + g.getId());
                    dto.setDisplayName(g.getDisplayName() != null ? g.getDisplayName() : "Unnamed Team");
                    String lastActive = g.getRenewedDateTime() != null ? g.getRenewedDateTime() : g.getCreatedDateTime();
                    dto.setLastActiveTime(lastActive);
                    dto.setCreateTime(g.getCreatedDateTime());
                    dto.setSpaceType("SPACE");
                    result.add(dto);
                }
                onProgress.accept("Fetched " + result.size() + " teams so far...");
                url = body.getOdataNextLink();
            } catch (Exception e) {
                if (isGraphAuthFailure(e)) {
                    throw wrapAuth(e);
                }
                log.error("Teams: error listing teams: {}", e.getMessage());
                onProgress.accept("Error fetching teams: " + e.getMessage());
                break;
            }
        } while (url != null);
        log.info("Teams: total teams fetched = {}", result.size());
        return result;
    }

    public List<SpaceDto> listAllChats(Consumer<String> onProgress) {
        return listAllChats(onProgress, null, null);
    }

    /**
     * List chats / DMs for the configured user(s). When start/end are provided, Graph is asked to
     * return only chats whose latest message is within the range
     * ({@code $filter=lastMessagePreview/createdDateTime ge ... and le ...}). {@code lastMessagePreview}
     * is always expanded so {@link SpaceDto#getLastActiveTime()} reflects real activity.
     */
    public List<SpaceDto> listAllChats(Consumer<String> onProgress, LocalDate start, LocalDate end) {
        Map<String, SpaceDto> deduped = new ConcurrentHashMap<>();
        onProgress.accept("Fetching users for chat enumeration...");
        try {
            List<UserDto> users = resolveUsersForChatScan();
            if (users.isEmpty()) {
                onProgress.accept("No user found for chat scan — check microsoft.admin.email or tenant users.");
                log.warn("Chats: user list for chat scan is empty");
                return new ArrayList<>();
            }
            if (users.size() > chatUserScanLimit) {
                users = users.subList(0, chatUserScanLimit);
            }
            final int totalUsers = users.size();
            onProgress.accept("Scanning chats for " + totalUsers + " user(s) (parallel)...");

            AtomicInteger processed = new AtomicInteger();
            try (ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor()) {
                List<CompletableFuture<Void>> tasks = users.stream()
                        .map(u -> CompletableFuture.runAsync(() -> {
                            fetchUserChats(u.getId(), deduped, start, end);
                            int p = processed.incrementAndGet();
                            if (p % 100 == 0 || p == totalUsers) {
                                onProgress.accept("Users " + p + "/" + totalUsers + ", unique chats " + deduped.size() + "...");
                            }
                        }, pool))
                        .toList();
                CompletableFuture.allOf(tasks.toArray(CompletableFuture[]::new)).join();
            }

            List<SpaceDto> list = new ArrayList<>(deduped.values());
            // With $expand=lastMessagePreview each chat already carries its latest message time — no second round-trip needed.
            // Fallback enrichment only runs for chats that still have no lastActiveTime.
            if (enrichChatLastMessage) {
                List<SpaceDto> missing = list.stream()
                        .filter(d -> d.getLastActiveTime() == null || d.getLastActiveTime().isBlank())
                        .toList();
                if (!missing.isEmpty()) {
                    enrichChatsWithLatestMessageTime(missing, onProgress);
                }
            }
            log.info("Chats: total unique = {}", list.size());
            return list;
        } catch (Exception e) {
            if (isGraphAuthFailure(e)) {
                throw wrapAuth(e);
            }
            log.warn("Chats: listing failed: {}", e.getMessage());
            onProgress.accept("Warning: could not fetch chats — " + e.getMessage());
            return new ArrayList<>();
        }
    }

    private void enrichChatsWithLatestMessageTime(List<SpaceDto> chats, Consumer<String> onProgress) {
        AtomicInteger done = new AtomicInteger();
        int n = chats.size();
        onProgress.accept("Resolving last message time for " + n + " chats (for date filter)...");
        try (ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor()) {
            List<CompletableFuture<Void>> tasks = chats.stream()
                    .map(dto -> CompletableFuture.runAsync(() -> {
                        if (dto.getName() == null || !dto.getName().startsWith("chats/")) {
                            return;
                        }
                        String rawId = dto.getName().substring("chats/".length());
                        try {
                            String enc = UriUtils.encodePathSegment(rawId, StandardCharsets.UTF_8);
                            String urlOrder = GRAPH + "/chats/" + enc
                                    + "/messages?$top=1&$orderby=createdDateTime%20desc&$select=createdDateTime";
                            MessagesResponse resp = null;
                            try {
                                resp = restTemplate.getForObject(URI.create(urlOrder), MessagesResponse.class);
                            } catch (Exception ex) {
                                String fallback = GRAPH + "/chats/" + enc + "/messages?$top=1&$select=createdDateTime";
                                try {
                                    resp = restTemplate.getForObject(URI.create(fallback), MessagesResponse.class);
                                } catch (Exception ignored) {
                                    log.debug("enrich chat {} (no orderby): {}", rawId, ex.getMessage());
                                }
                            }
                            if (resp != null && resp.getValue() != null && !resp.getValue().isEmpty()) {
                                String ts = resp.getValue().get(0).getCreatedDateTime();
                                if (ts != null && !ts.isBlank()) {
                                    dto.setLastActiveTime(ts);
                                }
                            }
                        } catch (Exception e) {
                            log.debug("enrich chat {}: {}", rawId, e.getMessage());
                        } finally {
                            int c = done.incrementAndGet();
                            if (c % 80 == 0 || c == n) {
                                onProgress.accept("Message time " + c + "/" + n + " chats...");
                            }
                        }
                    }, pool))
                    .toList();
            CompletableFuture.allOf(tasks.toArray(CompletableFuture[]::new)).join();
        }
    }

    /**
     * If {@code microsoft.admin.email} is set (e.g. {@code erik@filefuze.co}), only that identity is used for
     * {@code /users/{id}/chats}. Otherwise all enabled users in the tenant (same as before).
     */
    private List<UserDto> resolveUsersForChatScan() {
        if (microsoftAdminEmail != null && !microsoftAdminEmail.isBlank()) {
            String email = microsoftAdminEmail.trim();
            List<UserDto> one = fetchUserByUpnOrMail(email);
            if (!one.isEmpty()) {
                log.info("Teams: chat scan limited to user {} (id={})", email, one.get(0).getId());
                return one;
            }
            log.warn("Teams: could not resolve microsoft.admin.email={}, falling back to all enabled users", email);
        }
        return listAllUsers();
    }

    /** Resolve a single user by UPN or mail — used for scoped DM list. */
    private List<UserDto> fetchUserByUpnOrMail(String email) {
        List<UserDto> out = new ArrayList<>();
        try {
            String enc = UriUtils.encodePathSegment(email, StandardCharsets.UTF_8);
            String url = GRAPH + "/users/" + enc + "?$select=id,displayName,mail,userPrincipalName";
            UserDto u = restTemplate.getForObject(URI.create(url), UserDto.class);
            if (u != null && u.getId() != null) {
                out.add(u);
                return out;
            }
        } catch (Exception e) {
            log.info("Teams: direct user lookup failed for {}, trying filter: {}", email, e.getMessage());
        }
        try {
            String safe = email.replace("'", "''");
            String filter = "mail eq '" + safe + "' or userPrincipalName eq '" + safe + "'";
            String q = URLEncoder.encode(filter, StandardCharsets.UTF_8);
            String url = GRAPH + "/users?$select=id,displayName,mail,userPrincipalName&$filter=" + q + "&$top=5";
            UsersResponse resp = restTemplate.getForObject(URI.create(url), UsersResponse.class);
            if (resp != null && resp.getValue() != null) {
                out.addAll(resp.getValue());
            }
        } catch (Exception e) {
            log.error("Teams: filter user lookup failed for {}: {}", email, e.getMessage());
        }
        return out;
    }

    private List<UserDto> listAllUsers() {
        List<UserDto> users = new ArrayList<>();
        String url = GRAPH + "/users?$select=id,displayName,mail&$filter=accountEnabled%20eq%20true&$top=100";
        do {
            try {
                UsersResponse resp = restTemplate.getForObject(URI.create(url), UsersResponse.class);
                if (resp == null || resp.getValue() == null) break;
                users.addAll(resp.getValue());
                log.info("Users: fetched {} so far...", users.size());
                url = resp.getOdataNextLink();
            } catch (Exception e) {
                if (isGraphAuthFailure(e)) {
                    throw wrapAuth(e);
                }
                log.error("Users: listing failed: {}", e.getMessage());
                break;
            }
        } while (url != null);
        log.info("Users: total = {}", users.size());
        return users;
    }

    private void fetchUserChats(String userId, Map<String, SpaceDto> target) {
        fetchUserChats(userId, target, null, null);
    }

    /**
     * Calls {@code GET /users/{id}/chats} with {@code $expand=lastMessagePreview} so the response
     * carries the latest message time. When {@code start}/{@code end} are given, applies
     * {@code $filter=lastMessagePreview/createdDateTime ge ... and le ...} server-side. Falls back to
     * an unfiltered request if the tenant rejects the filter.
     */
    private void fetchUserChats(String userId, Map<String, SpaceDto> target, LocalDate start, LocalDate end) {
        String uid = UriUtils.encodePathSegment(userId, StandardCharsets.UTF_8);
        // Graph caps $top at 50 for /users/{id}/chats — requesting more returns 400.
        String baseUrl = GRAPH + "/users/" + uid
                + "/chats?$top=50&$expand=lastMessagePreview"
                + "&$select=id,chatType,topic,createdDateTime,lastUpdatedDateTime";
        String url = baseUrl;
        boolean serverFilterApplied = false;
        if (start != null && end != null) {
            String startIso = start.atStartOfDay(ZoneOffset.UTC).format(DateTimeFormatter.ISO_INSTANT);
            String endIso = end.plusDays(1).atStartOfDay(ZoneOffset.UTC).minusSeconds(1).format(DateTimeFormatter.ISO_INSTANT);
            String filter = "lastMessagePreview/createdDateTime ge " + startIso
                    + " and lastMessagePreview/createdDateTime le " + endIso;
            url = baseUrl + "&$filter=" + URLEncoder.encode(filter, StandardCharsets.UTF_8);
            serverFilterApplied = true;
        }
        try {
            do {
                ChatsResponse resp;
                try {
                    resp = restTemplate.getForObject(URI.create(url), ChatsResponse.class);
                } catch (Exception serverFilterEx) {
                    String m = serverFilterEx.getMessage() != null ? serverFilterEx.getMessage() : "";
                    if (serverFilterApplied && (m.contains("400") || m.contains("InvalidQuery"))) {
                        log.info("Chats: server-side date filter rejected for user {}, retrying without filter", userId);
                        url = baseUrl;
                        serverFilterApplied = false;
                        resp = restTemplate.getForObject(URI.create(url), ChatsResponse.class);
                    } else {
                        throw serverFilterEx;
                    }
                }
                if (resp == null || resp.getValue() == null) break;
                for (ChatDto c : resp.getValue()) {
                    if (c.getId() == null || c.getId().isBlank()) continue;
                    String chatType = c.getChatType() != null ? c.getChatType().trim() : "";
                    // meeting chats are not listed as DMs / group chats for this tool
                    if (chatType.equalsIgnoreCase("meeting")) continue;
                    SpaceDto dto = new SpaceDto();
                    dto.setName("chats/" + c.getId());
                    dto.setDisplayName(resolveChatName(c));
                    // Prefer the newest message's timestamp (real activity) over metadata lastUpdated.
                    String lastActive;
                    if (c.getLastMessagePreview() != null && c.getLastMessagePreview().getCreatedDateTime() != null) {
                        lastActive = c.getLastMessagePreview().getCreatedDateTime();
                    } else if (c.getLastUpdatedDateTime() != null) {
                        lastActive = c.getLastUpdatedDateTime();
                    } else {
                        lastActive = c.getCreatedDateTime();
                    }
                    dto.setLastActiveTime(lastActive);
                    dto.setCreateTime(c.getCreatedDateTime());
                    // oneOnOne + anything except group → DIRECT_MESSAGE (1:1 DMs); group → GROUP_CHAT
                    boolean isGroup = chatType.equalsIgnoreCase("group");
                    dto.setSpaceType(isGroup ? "GROUP_CHAT" : "DIRECT_MESSAGE");
                    target.putIfAbsent(dto.getName(), dto);
                }
                url = resp.getOdataNextLink();
            } while (url != null);
        } catch (Exception e) {
            if (isGraphAuthFailure(e)) {
                throw wrapAuth(e);
            }
            String m = e.getMessage() != null ? e.getMessage() : "";
            if (m.contains("429")) {
                log.warn("Chats: 429 throttle for user {} — skipping", userId);
            } else if (m.contains("403") || m.contains("Access denied") || m.contains("Insufficient privileges")) {
                log.warn("Chats: denied for user {} — ensure Chat.Read.All (application) is granted with admin consent: {}", userId, m);
            } else {
                log.warn("Chats for user {}: {}", userId, m);
            }
        }
    }

    /** Client-credentials / token failures must not look like “empty tenant”. */
    private static boolean isGraphAuthFailure(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            String m = t.getMessage();
            if (m == null) continue;
            if (m.contains("AADSTS") || m.contains("Graph token failed") || m.contains("MsalServiceException")
                    || m.contains("failed to acquire access token") || m.contains("Invalid client secret")) {
                return true;
            }
        }
        return false;
    }

    private static RuntimeException wrapAuth(Throwable e) {
        return e instanceof RuntimeException re ? re : new IllegalStateException(e.getMessage(), e);
    }

    private String resolveChatName(ChatDto c) {
        String ct = c.getChatType() != null ? c.getChatType().trim() : "";
        if (c.getTopic() != null && !c.getTopic().isBlank()) return c.getTopic();
        if (ct.equalsIgnoreCase("oneOnOne")) return "Direct Message";
        if (ct.equalsIgnoreCase("group")) return "Group Chat";
        return "Chat";
    }

    public List<SpaceInfo> findInDateRange(List<SpaceDto> items, LocalDate start, LocalDate end) {
        List<SpaceInfo> matched = new ArrayList<>();
        // Teams (SPACE): same as Google — single activity date.
        // Chats/DMs: use latest of parsed metadata dates for range; if dates cannot be parsed, still list the chat
        // so the UI is not stuck at 0 when Graph omits or sends odd formats.
        for (SpaceDto item : items) {
            String st = item.getSpaceType();
            LocalDate last = parseDate(item.getLastActiveTime());
            LocalDate created = parseDate(item.getCreateTime());
            LocalDate activeDate;
            boolean inRange;

            if ("SPACE".equals(st)) {
                activeDate = last != null ? last : created;
                inRange = activeDate != null
                        && !activeDate.isBefore(start)
                        && !activeDate.isAfter(end);
            } else {
                if (last == null && created == null) {
                    activeDate = end;
                    inRange = true;
                } else if (last != null && created != null) {
                    activeDate = last.isAfter(created) ? last : created;
                    inRange = !activeDate.isBefore(start) && !activeDate.isAfter(end);
                } else {
                    activeDate = last != null ? last : created;
                    inRange = activeDate != null
                            && !activeDate.isBefore(start)
                            && !activeDate.isAfter(end);
                }
            }

            if (inRange && activeDate != null) {
                String display = resolveTeamsItemDisplayName(item);
                matched.add(new SpaceInfo(item.getName(), display, activeDate, item.getSpaceType()));
            }
        }
        long teams = matched.stream().filter(s -> "SPACE".equals(s.spaceType())).count();
        long chats = matched.size() - teams;
        log.info("Teams matched: {} teams, {} DMs/chats", teams, chats);
        return matched;
    }

    /** Mirrors GoogleChatService.resolveDisplayName — stable labels for the DMs table. */
    private String resolveTeamsItemDisplayName(SpaceDto item) {
        if (item.getDisplayName() != null && !item.getDisplayName().isBlank()) {
            return item.getDisplayName();
        }
        String t = item.getSpaceType();
        if ("DIRECT_MESSAGE".equals(t)) return "Direct Message";
        if ("GROUP_CHAT".equals(t)) return "Group Chat";
        if ("SPACE".equals(t)) return item.getName() != null ? item.getName() : "Team";
        return item.getName() != null ? item.getName() : "";
    }

    public boolean deleteItem(String resourceName) {
        if (resourceName.startsWith("chats/")) {
            return purgeChatMessages(resourceName);
        }
        try {
            restTemplate.delete(GRAPH + "/" + resourceName);
            log.info("DELETED team: {}", resourceName);
            return true;
        } catch (Exception e) {
            log.error("FAILED to delete team {}: {}", resourceName, e.getMessage());
            return false;
        }
    }

    private boolean purgeChatMessages(String chatResource) {
        // chatResource = "chats/19:xxx@thread.v2" — IDs must be path-segment encoded
        String rawChatId = chatResource.startsWith("chats/") ? chatResource.substring("chats/".length()) : chatResource;
        String encChat = UriUtils.encodePathSegment(rawChatId, StandardCharsets.UTF_8);
        try {
            String url = GRAPH + "/chats/" + encChat + "/messages?$top=50";
            int deleted = 0;
            do {
                MessagesResponse resp = restTemplate.getForObject(URI.create(url), MessagesResponse.class);
                if (resp == null || resp.getValue() == null) break;
                for (MessageDto msg : resp.getValue()) {
                    if (msg.getDeletedDateTime() != null) continue; // already deleted
                    if ("unknownFutureValue".equals(msg.getMessageType())) continue;
                    try {
                        String encMsg = UriUtils.encodePathSegment(msg.getId(), StandardCharsets.UTF_8);
                        restTemplate.postForObject(
                            URI.create(GRAPH + "/chats/" + encChat + "/messages/" + encMsg + "/softDelete"),
                            null, String.class);
                        deleted++;
                    } catch (Exception e) {
                        log.debug("softDelete msg {} in {}: {}", msg.getId(), chatResource, e.getMessage());
                    }
                }
                url = resp.getOdataNextLink();
            } while (url != null);
            log.info("Purged {} messages from {}", deleted, chatResource);
            return true;
        } catch (Exception e) {
            log.error("FAILED to purge chat {}: {}", chatResource, e.getMessage());
            return false;
        }
    }

    private LocalDate parseDate(String dateStr) {
        if (dateStr == null || dateStr.isBlank()) return null;
        try {
            return OffsetDateTime.parse(dateStr, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toLocalDate();
        } catch (Exception ignored) { }
        try {
            return OffsetDateTime.parse(dateStr, DateTimeFormatter.ISO_ZONED_DATE_TIME).toLocalDate();
        } catch (Exception ignored) { }
        try {
            return ZonedDateTime.parse(dateStr, DateTimeFormatter.ISO_DATE_TIME).toLocalDate();
        } catch (Exception ignored) { }
        try {
            return Instant.parse(dateStr).atZone(ZoneOffset.UTC).toLocalDate();
        } catch (Exception ignored) { }
        try {
            return LocalDateTime.parse(dateStr, DateTimeFormatter.ISO_LOCAL_DATE_TIME).atZone(ZoneOffset.UTC).toLocalDate();
        } catch (Exception ignored) { }
        try {
            return LocalDate.parse(dateStr, DateTimeFormatter.ISO_LOCAL_DATE);
        } catch (Exception ignored) { }
        return null;
    }

    // ── DTOs ─────────────────────────────────────────────────────────────────

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class SpaceDto {
        private String name, displayName, lastActiveTime, createTime, spaceType;
        public String getName()            { return name; }
        public void   setName(String v)    { name = v; }
        public String getDisplayName()     { return displayName; }
        public void   setDisplayName(String v) { displayName = v; }
        public String getLastActiveTime()  { return lastActiveTime; }
        public void   setLastActiveTime(String v) { lastActiveTime = v; }
        public String getCreateTime()      { return createTime; }
        public void   setCreateTime(String v) { createTime = v; }
        public String getSpaceType()       { return spaceType; }
        public void   setSpaceType(String v) { spaceType = v; }
    }

    public record SpaceInfo(String name, String displayName, LocalDate lastActivity, String spaceType) {
        public String lastActivityStr() {
            return lastActivity != null ? lastActivity.toString() : "No activity";
        }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class GroupsResponse {
        private List<GroupDto> value;
        @JsonProperty("@odata.nextLink") private String odataNextLink;
        public List<GroupDto> getValue()        { return value; }
        public void           setValue(List<GroupDto> v) { value = v; }
        public String         getOdataNextLink() { return odataNextLink; }
        public void           setOdataNextLink(String v) { odataNextLink = v; }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class GroupDto {
        private String id, displayName, createdDateTime, renewedDateTime, description;
        public String getId()                    { return id; }
        public void   setId(String v)            { id = v; }
        public String getDisplayName()           { return displayName; }
        public void   setDisplayName(String v)   { displayName = v; }
        public String getCreatedDateTime()       { return createdDateTime; }
        public void   setCreatedDateTime(String v) { createdDateTime = v; }
        public String getRenewedDateTime()       { return renewedDateTime; }
        public void   setRenewedDateTime(String v) { renewedDateTime = v; }
        public String getDescription()           { return description; }
        public void   setDescription(String v)   { description = v; }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ChatsResponse {
        private List<ChatDto> value;
        @JsonProperty("@odata.nextLink") private String odataNextLink;
        public List<ChatDto> getValue()        { return value; }
        public void          setValue(List<ChatDto> v) { value = v; }
        public String        getOdataNextLink() { return odataNextLink; }
        public void          setOdataNextLink(String v) { odataNextLink = v; }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class UsersResponse {
        private List<UserDto> value;
        @JsonProperty("@odata.nextLink") private String odataNextLink;
        public List<UserDto> getValue()        { return value; }
        public void          setValue(List<UserDto> v) { value = v; }
        public String        getOdataNextLink() { return odataNextLink; }
        public void          setOdataNextLink(String v) { odataNextLink = v; }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class UserDto {
        private String id, displayName, mail, userPrincipalName;
        public String getId()            { return id; }
        public void   setId(String v)    { id = v; }
        public String getDisplayName()   { return displayName; }
        public void   setDisplayName(String v) { displayName = v; }
        public String getMail()          { return mail; }
        public void   setMail(String v)  { mail = v; }
        public String getUserPrincipalName() { return userPrincipalName; }
        public void   setUserPrincipalName(String v) { userPrincipalName = v; }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ChatDto {
        private String id, chatType, topic, createdDateTime, lastUpdatedDateTime;
        private LastMessagePreviewDto lastMessagePreview;
        public String getId()                    { return id; }
        public void   setId(String v)            { id = v; }
        public String getChatType()              { return chatType; }
        public void   setChatType(String v)      { chatType = v; }
        public String getTopic()                 { return topic; }
        public void   setTopic(String v)         { topic = v; }
        public String getCreatedDateTime()       { return createdDateTime; }
        public void   setCreatedDateTime(String v) { createdDateTime = v; }
        public String getLastUpdatedDateTime()   { return lastUpdatedDateTime; }
        public void   setLastUpdatedDateTime(String v) { lastUpdatedDateTime = v; }
        public LastMessagePreviewDto getLastMessagePreview()            { return lastMessagePreview; }
        public void                  setLastMessagePreview(LastMessagePreviewDto v) { lastMessagePreview = v; }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class LastMessagePreviewDto {
        private String id, createdDateTime;
        public String getId()                    { return id; }
        public void   setId(String v)            { id = v; }
        public String getCreatedDateTime()       { return createdDateTime; }
        public void   setCreatedDateTime(String v) { createdDateTime = v; }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class MessagesResponse {
        private List<MessageDto> value;
        @JsonProperty("@odata.nextLink") private String odataNextLink;
        public List<MessageDto> getValue()        { return value; }
        public void             setValue(List<MessageDto> v) { value = v; }
        public String           getOdataNextLink() { return odataNextLink; }
        public void             setOdataNextLink(String v) { odataNextLink = v; }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class MessageDto {
        private String id, messageType, deletedDateTime, createdDateTime;
        public String getId()                      { return id; }
        public void   setId(String v)              { id = v; }
        public String getMessageType()             { return messageType; }
        public void   setMessageType(String v)     { messageType = v; }
        public String getDeletedDateTime()         { return deletedDateTime; }
        public void   setDeletedDateTime(String v) { deletedDateTime = v; }
        public String getCreatedDateTime()         { return createdDateTime; }
        public void   setCreatedDateTime(String v) { createdDateTime = v; }
    }
}
