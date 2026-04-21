package com.cloudfuze.chatcleaner.controller;

import com.cloudfuze.chatcleaner.service.MicrosoftTeamsService;
import com.cloudfuze.chatcleaner.service.MicrosoftTeamsService.SpaceDto;
import com.cloudfuze.chatcleaner.service.MicrosoftTeamsService.SpaceInfo;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
@RestController
@RequestMapping("/api/teams")
public class TeamsCleanerController {

    private final MicrosoftTeamsService teamsService;

    public TeamsCleanerController(MicrosoftTeamsService teamsService) {
        this.teamsService = teamsService;
    }

    @GetMapping(value = "/preview", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter preview(@RequestParam String startDate, @RequestParam String endDate) {
        SseEmitter emitter = new SseEmitter(300_000L);
        CompletableFuture.runAsync(() -> {
            try {
                LocalDate start = LocalDate.parse(startDate);
                LocalDate end   = LocalDate.parse(endDate);
                send(emitter, "progress", "Fetching Teams and Chats from Microsoft Teams...");
                List<SpaceDto> all     = teamsService.listAll(msg -> send(emitter, "progress", msg));
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
                send(emitter, "log", "Fetching Teams and Chats...");
                List<SpaceDto>  all     = teamsService.listAll(msg -> send(emitter, "log", msg));
                List<SpaceInfo> matched = teamsService.findInDateRange(all, start, end);
                long teamCount = matched.stream().filter(s -> "SPACE".equals(s.spaceType())).count();
                long chatCount = matched.size() - teamCount;
                send(emitter, "log", "Found " + teamCount + " team(s) + " + chatCount + " chat(s). Deleting...");
                int success = 0, failed = 0;
                for (SpaceInfo item : matched) {
                    boolean ok = teamsService.deleteItem(item.name());
                    if (ok) {
                        success++;
                        send(emitter, "deleted", Map.of(
                            "id",  item.name(),
                            "msg", "DELETED [TEAM]: " + item.displayName() + "  [" + item.lastActivityStr() + "]"
                        ));
                    } else {
                        failed++;
                        send(emitter, "failed", Map.of(
                            "id",  item.name(),
                            "msg", "FAILED [TEAM]: " + item.displayName()
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
        String msg = e.getMessage();
        if (msg == null) return "Unknown error";
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
        if (msg.startsWith("403")) return "403 Forbidden — API permissions not granted. Add Group.ReadWrite.All, Chat.ReadBasic.All, User.Read.All in Azure Portal and grant admin consent.";
        if (msg.startsWith("401")) return "401 Unauthorized — Invalid credentials. Check tenant-id, client-id, and client-secret.";
        return msg.length() > 200 ? msg.substring(0, 200) : msg;
    }
}
