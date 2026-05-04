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
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.RestTemplate;

import java.net.URI;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
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
 * Slack Web API integration. Lists public channels, private channels, 1:1 DMs, group DMs
 * and returns {@link SpaceDto} items compatible with the Google Chat / Teams UIs.
 * <p>
 * On Business+ plans Slack cannot hard-delete channels or DMs, so {@link #deleteItem(String)}
 * uses the closest available actions:
 * <ul>
 *   <li>Public / private channel → {@code conversations.archive}</li>
 *   <li>1:1 DM / group DM → {@code conversations.close}</li>
 *   <li>If {@code slack.delete-messages=true}, every message in the conversation is removed
 *       with {@code chat.delete} before archiving.</li>
 * </ul>
 * On Enterprise Grid set {@code slack.enterprise-grid=true} and supply
 * {@code slack.enterprise-admin-token} to use {@code admin.conversations.delete}.
 */
@Service
public class SlackService {

    private static final Logger log = LoggerFactory.getLogger(SlackService.class);
    private static final String BASE = "https://slack.com/api";

    private final RestTemplate restTemplate;

    @Value("${slack.enterprise-grid:false}")     private boolean enterpriseGrid;
    @Value("${slack.enterprise-admin-token:}")   private String enterpriseAdminToken;
    @Value("${slack.delete-messages:false}")     private boolean deleteMessages;
    @Value("${slack.channel-scan-limit:2000}")   private int channelScanLimit;
    @Value("${slack.enrich-last-message:true}")  private boolean enrichLastMessage;
    @Value("${slack.admin.user:}")               private String adminUserRef;

    /** username cache to label DMs without burning extra users.info calls. */
    private final Map<String, String> userNameCache = new ConcurrentHashMap<>();

    public SlackService(@Qualifier("slackRestTemplate") RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Listing
    // ──────────────────────────────────────────────────────────────────────

    public List<SpaceDto> listAllChannels(Consumer<String> onProgress) {
        return listAllChannels(onProgress, null, null);
    }

    /**
     * List every conversation (public + private channels, 1:1 DMs, group DMs) and, if
     * enabled, enrich each with its latest-message {@code ts} for date-range filtering.
     * The date arguments are accepted for symmetry with {@code MicrosoftTeamsService} —
     * Slack has no server-side filter, so filtering is done client-side in
     * {@link #findInDateRange(List, LocalDate, LocalDate)}.
     */
    public List<SpaceDto> listAllChannels(Consumer<String> onProgress, LocalDate start, LocalDate end) {
        List<SpaceDto> all = new ArrayList<>();
        onProgress.accept("Slack: fetching conversations (public + private + mpim + im)...");
        String cursor = null;
        int page = 0;
        try {
            do {
                String url = BASE + "/conversations.list?types=public_channel,private_channel,mpim,im"
                        + "&exclude_archived=true&limit=200";
                if (cursor != null && !cursor.isBlank()) {
                    url += "&cursor=" + encode(cursor);
                }
                ConversationsListResponse resp = restTemplate.getForObject(URI.create(url), ConversationsListResponse.class);
                if (resp == null) break;
                if (!resp.ok) {
                    throw new IllegalStateException("Slack conversations.list failed: " + resp.error);
                }
                if (resp.channels != null) {
                    for (SlackChannel c : resp.channels) {
                        if (c.id == null || c.id.isBlank()) continue;
                        all.add(toSpaceDto(c));
                    }
                }
                onProgress.accept("Slack: fetched " + all.size() + " so far...");
                cursor = resp.responseMetadata != null ? resp.responseMetadata.nextCursor : null;
                if (++page > 500) break; // safety
            } while (cursor != null && !cursor.isBlank() && all.size() < channelScanLimit);

            if (all.size() > channelScanLimit) {
                all = all.subList(0, channelScanLimit);
            }

            long channels = all.stream().filter(s -> "SPACE".equals(s.spaceType)).count();
            long ims      = all.stream().filter(s -> "DIRECT_MESSAGE".equals(s.spaceType)).count();
            long mpims    = all.stream().filter(s -> "GROUP_CHAT".equals(s.spaceType)).count();
            onProgress.accept("Slack: " + channels + " channels, " + ims + " DMs, " + mpims + " group DMs");

            if (enrichLastMessage && !all.isEmpty()) {
                enrichLatestMessage(all, onProgress);
            }
            return all;
        } catch (RuntimeException e) {
            log.warn("Slack: listing failed: {}", e.getMessage());
            onProgress.accept("Warning: Slack listing failed — " + e.getMessage());
            return all;
        }
    }

    private SpaceDto toSpaceDto(SlackChannel c) {
        SpaceDto d = new SpaceDto();
        d.id = c.id;
        d.name = "slack/" + c.id;
        d.createTime = formatUnix(c.created);
        d.lastActiveTime = d.createTime; // filled in by enrichLatestMessage()
        if (Boolean.TRUE.equals(c.isIm)) {
            d.spaceType = "DIRECT_MESSAGE";
            d.displayName = resolveUserName(c.user);
        } else if (Boolean.TRUE.equals(c.isMpim)) {
            d.spaceType = "GROUP_CHAT";
            d.displayName = c.name != null && !c.name.isBlank() ? c.name : "Group DM";
        } else {
            d.spaceType = "SPACE";
            d.displayName = c.name != null && !c.name.isBlank() ? c.name : "channel";
        }
        return d;
    }

    /** Pulls the newest message's {@code ts} per conversation (parallel). */
    private void enrichLatestMessage(List<SpaceDto> list, Consumer<String> onProgress) {
        int n = list.size();
        onProgress.accept("Slack: reading last-message time for " + n + " conversations (for date filter)...");
        AtomicInteger done = new AtomicInteger();
        try (ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor()) {
            List<CompletableFuture<Void>> tasks = list.stream()
                    .map(dto -> CompletableFuture.runAsync(() -> {
                        try {
                            String url = BASE + "/conversations.history?channel=" + encode(dto.id) + "&limit=1";
                            HistoryResponse h = restTemplate.getForObject(URI.create(url), HistoryResponse.class);
                            if (h != null && h.ok && h.messages != null && !h.messages.isEmpty()) {
                                String ts = h.messages.get(0).ts;
                                if (ts != null) dto.lastActiveTime = formatUnix(parseTs(ts));
                            } else if (h != null && !h.ok) {
                                log.debug("Slack history {}: {}", dto.id, h.error);
                            }
                        } catch (RuntimeException ex) {
                            log.debug("Slack history {}: {}", dto.id, ex.getMessage());
                        } finally {
                            int c = done.incrementAndGet();
                            if (c % 50 == 0 || c == n) {
                                onProgress.accept("Slack: last-message " + c + "/" + n + "...");
                            }
                        }
                    }, pool))
                    .toList();
            CompletableFuture.allOf(tasks.toArray(CompletableFuture[]::new)).join();
        }
    }

    private String resolveUserName(String userId) {
        if (userId == null || userId.isBlank()) return "Direct Message";
        return userNameCache.computeIfAbsent(userId, uid -> {
            try {
                String url = BASE + "/users.info?user=" + encode(uid);
                UserInfoResponse r = restTemplate.getForObject(URI.create(url), UserInfoResponse.class);
                if (r != null && r.ok && r.user != null) {
                    if (r.user.realName != null && !r.user.realName.isBlank()) return r.user.realName;
                    if (r.user.name     != null && !r.user.name.isBlank())     return r.user.name;
                }
            } catch (RuntimeException ex) {
                log.debug("Slack users.info {}: {}", uid, ex.getMessage());
            }
            return "DM (" + uid + ")";
        });
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Date-range filter (same contract as GoogleChatService / Teams)
    // ──────────────────────────────────────────────────────────────────────

    public List<SpaceInfo> findInDateRange(List<SpaceDto> items, LocalDate startDate, LocalDate endDate) {
        List<SpaceInfo> matched = new ArrayList<>();
        for (SpaceDto d : items) {
            LocalDate date = parseDate(d.lastActiveTime);
            if (date == null) date = parseDate(d.createTime);
            if (date == null) continue;
            if (date.isBefore(startDate) || date.isAfter(endDate)) continue;
            matched.add(new SpaceInfo(d.name, d.displayName, date, d.spaceType));
        }
        long channels = matched.stream().filter(s -> "SPACE".equals(s.spaceType())).count();
        long chats = matched.size() - channels;
        log.info("Slack matched: {} channels, {} DMs/group DMs", channels, chats);
        return matched;
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Delete
    // ──────────────────────────────────────────────────────────────────────

    /**
     * "Delete" an item by its {@link SpaceDto#getName()} ({@code slack/<CID>}).
     *  • channels → {@code conversations.archive} (or {@code admin.conversations.delete} on Grid)<br>
     *  • DMs / group DMs → {@code conversations.close}<br>
     * If {@code slack.delete-messages=true}, messages are removed first with {@code chat.delete}.
     */
    public boolean deleteItem(String fullName) {
        String id = stripPrefix(fullName);
        if (id == null) return false;
        String type = detectType(id);
        try {
            if (deleteMessages) {
                purgeMessages(id);
            }
            if ("SPACE".equals(type)) {
                return enterpriseGrid ? adminDeleteChannel(id) : archiveChannel(id);
            }
            return closeConversation(id);
        } catch (RuntimeException e) {
            log.warn("Slack: delete {} failed: {}", id, e.getMessage());
            return false;
        }
    }

    private boolean archiveChannel(String id) {
        SlackApiResponse r = postForm("/conversations.archive", Map.of("channel", id));
        if (!r.ok) log.warn("Slack conversations.archive {} failed: {}", id, r.error);
        return r.ok;
    }

    private boolean closeConversation(String id) {
        SlackApiResponse r = postForm("/conversations.close", Map.of("channel", id));
        if (!r.ok) log.warn("Slack conversations.close {} failed: {}", id, r.error);
        return r.ok;
    }

    /** Enterprise Grid only — Org Admin token required. */
    private boolean adminDeleteChannel(String id) {
        if (enterpriseAdminToken == null || enterpriseAdminToken.isBlank()) {
            log.warn("Slack: enterprise-grid=true but slack.enterprise-admin-token is blank — falling back to archive");
            return archiveChannel(id);
        }
        HttpHeaders h = new HttpHeaders();
        h.setBearerAuth(enterpriseAdminToken);
        h.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("channel_id", id);
        SlackApiResponse r = restTemplate.exchange(
                URI.create(BASE + "/admin.conversations.delete"),
                HttpMethod.POST, new HttpEntity<>(form, h), SlackApiResponse.class).getBody();
        if (r == null || !r.ok) {
            log.warn("Slack admin.conversations.delete {} failed: {}", id, r != null ? r.error : "null");
            return false;
        }
        return true;
    }

    private void purgeMessages(String channelId) {
        String cursor = null;
        do {
            String url = BASE + "/conversations.history?channel=" + encode(channelId) + "&limit=100"
                    + (cursor != null ? "&cursor=" + encode(cursor) : "");
            HistoryResponse h = restTemplate.getForObject(URI.create(url), HistoryResponse.class);
            if (h == null || !h.ok || h.messages == null) break;
            for (SlackMessage m : h.messages) {
                if (m.ts == null) continue;
                postForm("/chat.delete", Map.of("channel", channelId, "ts", m.ts));
            }
            cursor = h.responseMetadata != null ? h.responseMetadata.nextCursor : null;
        } while (cursor != null && !cursor.isBlank());
    }

    private SlackApiResponse postForm(String path, Map<String, String> fields) {
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        fields.forEach(form::add);
        SlackApiResponse r = restTemplate.exchange(
                URI.create(BASE + path),
                HttpMethod.POST, new HttpEntity<>(form, h), SlackApiResponse.class).getBody();
        return r != null ? r : new SlackApiResponse();
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Small helpers
    // ──────────────────────────────────────────────────────────────────────

    private static String stripPrefix(String name) {
        if (name == null) return null;
        return name.startsWith("slack/") ? name.substring("slack/".length()) : name;
    }

    // Slack channel-ID prefixes: C = public channel, G = private channel or group DM (mpim),
    // D = 1:1 IM. We only have the ID here so we infer by first char; callers use the richer
    // SpaceDto.spaceType when available.
    private static String detectType(String id) {
        if (id == null || id.isEmpty()) return "SPACE";
        char c = id.charAt(0);
        if (c == 'D') return "DIRECT_MESSAGE";
        return "SPACE";
    }

    private static String encode(String s) {
        return java.net.URLEncoder.encode(s, java.nio.charset.StandardCharsets.UTF_8);
    }

    private static String formatUnix(long unixSeconds) {
        if (unixSeconds <= 0) return null;
        return Instant.ofEpochSecond(unixSeconds).atOffset(ZoneOffset.UTC).toString();
    }

    private static long parseTs(String ts) {
        if (ts == null || ts.isBlank()) return 0L;
        try { return (long) Double.parseDouble(ts); } catch (NumberFormatException e) { return 0L; }
    }

    private static LocalDate parseDate(String iso) {
        if (iso == null || iso.isBlank()) return null;
        try { return java.time.OffsetDateTime.parse(iso).toLocalDate(); }
        catch (Exception ignore) { return null; }
    }

    // ──────────────────────────────────────────────────────────────────────
    //  DTOs
    // ──────────────────────────────────────────────────────────────────────

    /** Shape-compatible with {@code GoogleChatService.SpaceDto} / {@code MicrosoftTeamsService.SpaceDto} for the UI. */
    public static class SpaceDto {
        private String id;
        private String name;          // "slack/<CID>" — sent to the UI and to deleteItem()
        private String displayName;
        private String lastActiveTime; // ISO-8601
        private String createTime;     // ISO-8601
        private String spaceType;      // SPACE | DIRECT_MESSAGE | GROUP_CHAT
        public String getId()             { return id; }
        public String getName()           { return name; }
        public String getDisplayName()    { return displayName; }
        public String getLastActiveTime() { return lastActiveTime; }
        public String getCreateTime()     { return createTime; }
        public String getSpaceType()      { return spaceType; }
    }

    public record SpaceInfo(String name, String displayName, LocalDate lastActivity, String spaceType) {
        public String lastActivityStr() { return lastActivity != null ? lastActivity.toString() : "No activity"; }
    }

    // ── Slack API response models ──────────────────────────────────────────

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class SlackApiResponse {
        public boolean ok;
        public String error;
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ConversationsListResponse extends SlackApiResponse {
        public List<SlackChannel> channels;
        @JsonProperty("response_metadata")
        public ResponseMetadata responseMetadata;
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class HistoryResponse extends SlackApiResponse {
        public List<SlackMessage> messages;
        @JsonProperty("response_metadata")
        public ResponseMetadata responseMetadata;
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class UserInfoResponse extends SlackApiResponse {
        public SlackUser user;
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class SlackChannel {
        public String id;
        public String name;
        public long   created;
        @JsonProperty("is_im")      public Boolean isIm;
        @JsonProperty("is_mpim")    public Boolean isMpim;
        @JsonProperty("is_private") public Boolean isPrivate;
        public String user;
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class SlackMessage {
        public String ts;
        public String user;
        public String type;
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class SlackUser {
        public String id;
        public String name;
        @JsonProperty("real_name") public String realName;
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ResponseMetadata {
        @JsonProperty("next_cursor") public String nextCursor;
    }
}
