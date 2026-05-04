package com.cloudfuze.chatcleaner;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

@SpringBootApplication
public class ChatCleanerApplication {
    public static void main(String[] args) {
        SpringApplication.run(ChatCleanerApplication.class, args);
    }

    @Component
    static class BrowserLauncher {
        @EventListener(ApplicationReadyEvent.class)
        public void openBrowser() {
            try {
                Runtime.getRuntime().exec(new String[]{"cmd", "/c", "start", "http://localhost:8080"});
            } catch (Exception ignored) {}
        }
    }
}
