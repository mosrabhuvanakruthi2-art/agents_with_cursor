package com.cloudfuze.chatcleaner.controller;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import com.cloudfuze.chatcleaner.service.MicrosoftTeamsService;
import com.cloudfuze.chatcleaner.service.MicrosoftTeamsService.SpaceDto;
import com.cloudfuze.chatcleaner.service.MicrosoftTeamsService.SpaceInfo;
@RestController
@RequestMapping("/api/teams")
public class TeamsCleanerController {

    private final MicrosoftTeamsService teamsService;

    @Value("${microsoft.client-id:}")
    private String clientId;

    @Value("${microsoft.tenant-id:}")
    private String tenantId;

    public TeamsCleanerController(MicrosoftTeamsService teamsService) {
        this.teamsService = teamsService;
    }

    @GetMapping(value = "/preview", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter preview(@RequestParam String startDate, @RequestParam String endDate) {
        SseEmitter emitter = new SseEmitter(1_200_000L);
        CompletableFuture.runAsync(() -> {
            try {
                LocalDate start = LocalDate.parse(startDate);
                LocalDate end   = LocalDate.parse(endDate);

                // Step 1: fetch teams and show immediately
                send(emitter, "progress", "Fetching Teams...");
                List<SpaceDto> teamItems = teamsService.listAllTeams(msg -> send(emitter, "progress", msg));
                List<SpaceInfo> teamsOnly = teamsService.findInDateRange(teamItems, start, end);
                send(emitter, "partial", teamsOnly);

                // Step 2: fetch chats (Graph-side date-range filter) and send full result
                send(emitter, "progress", "Fetching Chats / DMs (date-filtered)...");
                List<SpaceDto> chatItems = teamsService.listAllChats(
                        msg -> send(emitter, "progress", msg), start, end);
                List<SpaceDto> all = new ArrayList<>(teamItems);
                all.addAll(chatItems);
                List<SpaceInfo> matched = teamsService.findInDateRange(all, start, end);
                send(emitter, "result", matched);
                emitter.complete();
            } catch (Exception e) {
                send(emitter, "fail", cleanError(e));
                emitter.complete();
            }
        });
        return emitter;
    }

    @GetMapping(value = "/delete", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter delete(@RequestParam String startDate, @RequestParam String endDate) {
        SseEmitter emitter = new SseEmitter(600_000L);
        CompletableFuture.runAsync(() -> {
            try {
                LocalDate start = LocalDate.parse(startDate);
                LocalDate end   = LocalDate.parse(endDate);
                send(emitter, "log", "Fetching Teams and Chats (date-filtered)...");
                List<SpaceDto>  all     = teamsService.listAll(msg -> send(emitter, "log", msg), start, end);
                List<SpaceInfo> matched = teamsService.findInDateRange(all, start, end);
                long teamCount = matched.stream().filter(s -> "SPACE".equals(s.spaceType())).count();
                long chatCount = matched.size() - teamCount;
                send(emitter, "log", "Found " + teamCount + " teams + " + chatCount + " DMs/chats. Starting deletion...");
                int success = 0, failed = 0;
                for (SpaceInfo item : matched) {
                    boolean ok = teamsService.deleteItem(item.name());
                    String label = deletionTypeLabel(item.spaceType());
                    if (ok) {
                        success++;
                        send(emitter, "deleted", Map.of(
                            "id",  item.name(),
                            "msg", "DELETED " + label + ": " + item.displayName() + "  [" + item.lastActivityStr() + "]"
                        ));
                    } else {
                        failed++;
                        send(emitter, "failed", Map.of(
                            "id",  item.name(),
                            "msg", "FAILED " + label + ": " + item.displayName()
                        ));
                    }
                }
                send(emitter, "done", "Done — Deleted: " + success + " | Failed: " + failed);
                emitter.complete();
            } catch (Exception e) {
                send(emitter, "fail", cleanError(e));
                emitter.complete();
            }
        });
        return emitter;
    }

    @PostMapping(value = "/delete-selected",
                 consumes = MediaType.APPLICATION_JSON_VALUE,
                 produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter deleteSelected(@RequestBody List<String> ids) {
        SseEmitter emitter = new SseEmitter(600_000L);
        CompletableFuture.runAsync(() -> {
            try {
                send(emitter, "log", "Deleting " + ids.size() + " selected item(s)...");
                int success = 0, failed = 0;
                for (String id : ids) {
                    boolean ok = teamsService.deleteItem(id);
                    if (ok) {
                        success++;
                        send(emitter, "deleted", Map.of("id", id, "msg", "DELETED: " + id));
                    } else {
                        failed++;
                        send(emitter, "failed", Map.of("id", id, "msg", "FAILED: " + id));
                    }
                }
                send(emitter, "done", "Done — Deleted: " + success + " | Failed: " + failed);
                emitter.complete();
            } catch (Exception e) {
                send(emitter, "fail", cleanError(e));
                emitter.complete();
            }
        });
        return emitter;
    }

    private void send(SseEmitter emitter, String event, Object data) {
        try {
            emitter.send(SseEmitter.event().name(event).data(data, MediaType.APPLICATION_JSON));
        } catch (Exception ignored) {}
    }

    private String cleanError(Exception e) {
        // Walk the whole cause chain so the real Azure error (often wrapped in
        // IllegalStateException("Microsoft Graph token failed ...")) is visible.
        String chain = collectCauseMessages(e);
        if (chain.isBlank()) return "Unknown error";
        if (chain.contains("AADSTS7000215") || chain.contains("Invalid client secret")) {
            return "Azure login failed (AADSTS7000215): the client secret in application-local.properties is not valid for app "
                    + clientId + ". In Azure Portal → App registrations open the app with this client id → "
                    + "Certificates & secrets → create a new secret and paste the *Value* column (not Secret ID) into "
                    + "microsoft.client-secret, then restart.";
        }
        if (chain.contains("AADSTS700016")) {
            return "Azure login failed (AADSTS700016): client id " + clientId
                    + " is not found in tenant " + tenantId + ". Either the client id or the tenant id is wrong.";
        }
        if (chain.contains("AADSTS90002")) {
            return "Azure login failed (AADSTS90002): tenant " + tenantId + " does not exist. Fix microsoft.tenant-id.";
        }
        if (chain.contains("Microsoft Graph token failed")) {
            return "Microsoft Graph authentication failed. Underlying error: " + chain;
        }
        String msg = e.getMessage() == null ? chain : e.getMessage();
        // Extract just the Graph API error message if present
        try {
            int start = msg.indexOf("\"message\":\"");
            if (start >= 0) {
                start += 11;
                int end = msg.indexOf("\"", start);
                if (end > start) return msg.substring(start, end);
            }
        } catch (Exception ignored) {}
        // Trim raw HTTP prefix for readability
        if (msg.startsWith("403")) return "403 Forbidden — API permissions not granted. Add application permissions: User.Read.All, Group.Read.All or Group.ReadWrite.All, Chat.Read.All, grant admin consent.";
        if (msg.startsWith("401")) return "401 Unauthorized — Invalid credentials. Check tenant-id, client-id, and client-secret.";
        return msg.length() > 200 ? msg.substring(0, 200) : msg;
    }

    /** Walk the whole cause chain so wrappers don't hide the root Azure/Graph error. */
    private static String collectCauseMessages(Throwable e) {
        StringBuilder sb = new StringBuilder();
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t.getMessage() != null) {
                if (sb.length() > 0) sb.append(" | ");
                sb.append(t.getMessage());
            }
            if (t.getCause() == t) break;
        }
        return sb.toString();
    }

    /** Same idea as Google Chat's [SPACE] vs [DM] — teams vs 1:1 vs group chats. */
    private static String deletionTypeLabel(String spaceType) {
        if (spaceType == null) return "[CHAT]";
        return switch (spaceType) {
            case "SPACE" -> "[TEAM]";
            case "DIRECT_MESSAGE" -> "[DM]";
            case "GROUP_CHAT" -> "[GROUP CHAT]";
            default -> "[CHAT]";
        };
    }
}
