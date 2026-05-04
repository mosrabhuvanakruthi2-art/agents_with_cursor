package com.cloudfuze.chatcleaner.controller;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import com.cloudfuze.chatcleaner.service.SlackService;
import com.cloudfuze.chatcleaner.service.SlackService.SpaceDto;
import com.cloudfuze.chatcleaner.service.SlackService.SpaceInfo;

/**
 * Mirrors {@code TeamsCleanerController} / {@code SpaceCleanerController} so the single-page
 * UI works the same for Slack: date-range preview, delete-all, delete-selected via SSE.
 */
@RestController
@RequestMapping("/api/slack")
public class SlackCleanerController {

    private final SlackService slackService;

    public SlackCleanerController(SlackService slackService) {
        this.slackService = slackService;
    }

    @GetMapping(value = "/preview", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter preview(@RequestParam String startDate, @RequestParam String endDate) {
        SseEmitter emitter = new SseEmitter(1_200_000L);
        CompletableFuture.runAsync(() -> {
            try {
                LocalDate start = LocalDate.parse(startDate);
                LocalDate end   = LocalDate.parse(endDate);

                send(emitter, "progress", "Fetching Slack channels + DMs...");
                List<SpaceDto> items = slackService.listAllChannels(msg -> send(emitter, "progress", msg), start, end);
                List<SpaceInfo> matched = slackService.findInDateRange(items, start, end);
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
        SseEmitter emitter = new SseEmitter(1_200_000L);
        CompletableFuture.runAsync(() -> {
            try {
                LocalDate start = LocalDate.parse(startDate);
                LocalDate end   = LocalDate.parse(endDate);
                send(emitter, "log", "Fetching Slack channels + DMs (date-filtered)...");
                List<SpaceDto>  all     = slackService.listAllChannels(msg -> send(emitter, "log", msg), start, end);
                List<SpaceInfo> matched = slackService.findInDateRange(all, start, end);
                long channels = matched.stream().filter(s -> "SPACE".equals(s.spaceType())).count();
                long chats    = matched.size() - channels;
                send(emitter, "log", "Found " + channels + " channel(s) + " + chats + " DM(s)/group DM(s). Archiving/closing...");
                int ok = 0, fail = 0;
                for (SpaceInfo item : matched) {
                    boolean done = slackService.deleteItem(item.name());
                    String label = typeLabel(item.spaceType());
                    if (done) {
                        ok++;
                        send(emitter, "deleted", Map.of(
                            "id",  item.name(),
                            "msg", "DONE " + label + ": " + item.displayName() + "  [" + item.lastActivityStr() + "]"
                        ));
                    } else {
                        fail++;
                        send(emitter, "failed", Map.of(
                            "id",  item.name(),
                            "msg", "FAILED " + label + ": " + item.displayName()
                        ));
                    }
                }
                send(emitter, "done", "Done — Archived/Closed: " + ok + " | Failed: " + fail);
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
        SseEmitter emitter = new SseEmitter(1_200_000L);
        CompletableFuture.runAsync(() -> {
            try {
                send(emitter, "log", "Deleting " + ids.size() + " selected Slack item(s)...");
                int ok = 0, fail = 0;
                for (String id : ids) {
                    boolean done = slackService.deleteItem(id);
                    if (done) {
                        ok++;
                        send(emitter, "deleted", Map.of("id", id, "msg", "DONE: " + id));
                    } else {
                        fail++;
                        send(emitter, "failed", Map.of("id", id, "msg", "FAILED: " + id));
                    }
                }
                send(emitter, "done", "Done — Archived/Closed: " + ok + " | Failed: " + fail);
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

    private static String typeLabel(String spaceType) {
        if (spaceType == null) return "[CHAT]";
        return switch (spaceType) {
            case "SPACE"          -> "[CHANNEL]";
            case "DIRECT_MESSAGE" -> "[DM]";
            case "GROUP_CHAT"     -> "[GROUP DM]";
            default               -> "[CHAT]";
        };
    }

    private String cleanError(Exception e) {
        String msg = e.getMessage();
        if (msg == null) return "Unknown error";
        if (msg.contains("invalid_auth") || msg.contains("not_authed")) {
            return "Slack: token invalid or expired. Reinstall the app to Workspace and update slack.user-token in application-local.properties.";
        }
        if (msg.contains("missing_scope")) {
            return "Slack: missing scope on the user token. Add the scopes listed in the Slack setup, then Reinstall to Workspace.";
        }
        if (msg.contains("ratelimited")) {
            return "Slack: rate-limited. Wait a minute and retry (Slack API caps preview/history calls).";
        }
        return msg.length() > 220 ? msg.substring(0, 220) : msg;
    }
}
