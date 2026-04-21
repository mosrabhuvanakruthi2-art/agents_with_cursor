package com.cloudfuze.chatcleaner.controller;

import com.cloudfuze.chatcleaner.service.GoogleChatService;
import com.cloudfuze.chatcleaner.service.GoogleChatService.SpaceDto;
import com.cloudfuze.chatcleaner.service.GoogleChatService.SpaceInfo;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.time.LocalDate;
import java.util.List;
import java.util.concurrent.CompletableFuture;

@RestController
@RequestMapping("/api")
public class SpaceCleanerController {

    private final GoogleChatService chatService;

    public SpaceCleanerController(GoogleChatService chatService) {
        this.chatService = chatService;
    }

    @GetMapping(value = "/preview", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter preview(@RequestParam String startDate, @RequestParam String endDate) {
        SseEmitter emitter = new SseEmitter(300_000L);
        CompletableFuture.runAsync(() -> {
            try {
                LocalDate start = LocalDate.parse(startDate);
                LocalDate end = LocalDate.parse(endDate);
                send(emitter, "progress", "Fetching spaces and DMs from Google Chat...");
                List<SpaceDto> all = chatService.listAllSpaces(msg -> send(emitter, "progress", msg));
                List<SpaceInfo> matched = chatService.findInDateRange(all, start, end);
                send(emitter, "result", matched);
                emitter.complete();
            } catch (Exception e) {
                send(emitter, "fail", e.getMessage());
                emitter.completeWithError(e);
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
                LocalDate end = LocalDate.parse(endDate);
                send(emitter, "log", "Fetching spaces and DMs...");
                List<SpaceDto> all = chatService.listAllSpaces(msg -> send(emitter, "log", msg));
                List<SpaceInfo> matched = chatService.findInDateRange(all, start, end);
                long spaceCount = matched.stream().filter(s -> "SPACE".equals(s.spaceType())).count();
                long dmCount = matched.size() - spaceCount;
                send(emitter, "log", "Found " + spaceCount + " spaces + " + dmCount + " DMs. Starting deletion...");
                int success = 0, failed = 0;
                for (SpaceInfo item : matched) {
                    boolean ok = chatService.deleteSpace(item.name());
                    String typeLabel = "SPACE".equals(item.spaceType()) ? "[SPACE]" : "[DM]";
                    if (ok) {
                        success++;
                        send(emitter, "deleted", java.util.Map.of(
                            "id",  item.name(),
                            "msg", "DELETED " + typeLabel + ": " + item.displayName() + "  [" + item.lastActivityStr() + "]"
                        ));
                    } else {
                        failed++;
                        send(emitter, "failed", java.util.Map.of(
                            "id",  item.name(),
                            "msg", "FAILED  " + typeLabel + ": " + item.displayName()
                        ));
                    }
                }
                send(emitter, "done", "Done — Deleted: " + success + " | Failed: " + failed);
                emitter.complete();
            } catch (Exception e) {
                send(emitter, "fail", e.getMessage());
                emitter.completeWithError(e);
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
                    boolean ok = chatService.deleteSpace(id);
                    if (ok) {
                        success++;
                        send(emitter, "deleted", java.util.Map.of(
                            "id",  id,
                            "msg", "DELETED: " + id
                        ));
                    } else {
                        failed++;
                        send(emitter, "failed", java.util.Map.of(
                            "id",  id,
                            "msg", "FAILED: " + id
                        ));
                    }
                }
                send(emitter, "done", "Done — Deleted: " + success + " | Failed: " + failed);
                emitter.complete();
            } catch (Exception e) {
                send(emitter, "fail", e.getMessage());
                emitter.completeWithError(e);
            }
        });
        return emitter;
    }

    private void send(SseEmitter emitter, String event, Object data) {
        try {
            emitter.send(SseEmitter.event().name(event).data(data, MediaType.APPLICATION_JSON));
        } catch (Exception ignored) {}
    }
}
