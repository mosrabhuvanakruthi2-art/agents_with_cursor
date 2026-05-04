package com.cloudfuze.chatcleaner.controller;

import com.cloudfuze.chatcleaner.config.GoogleConfig;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Reports which cleaners are actually usable right now, so the UI can
 * show a clear banner instead of silently hanging on a broken config.
 * Path: GET /api/status  (through Node proxy: GET /api/chat-cleaner/status).
 */
@RestController
@RequestMapping("/api")
public class StatusController {

    private final GoogleConfig googleConfig;

    @Value("${slack.user-token:}")
    private String slackToken;

    @Value("${slack.team-id:}")
    private String slackTeamId;

    @Value("${microsoft.client-id:}")
    private String msClientId;

    @Value("${microsoft.client-secret:}")
    private String msClientSecret;

    @Value("${microsoft.tenant-id:}")
    private String msTenantId;

    @Value("${microsoft.admin.email:}")
    private String msAdminEmail;

    public StatusController(GoogleConfig googleConfig) {
        this.googleConfig = googleConfig;
    }

    @GetMapping("/status")
    public Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();

        Map<String, Object> g = new LinkedHashMap<>();
        g.put("configured", googleConfig.isConfigured());
        g.put("reason", googleConfig.getDisabledReason());
        out.put("gchat", g);

        Map<String, Object> t = new LinkedHashMap<>();
        // admin.email is OPTIONAL — when blank, the cleaner scans all enabled users for DMs/chats.
        boolean tCreds = notBlank(msClientId) && notBlank(msClientSecret) && notBlank(msTenantId);
        t.put("configured", tCreds);
        if (!tCreds) {
            t.put("reason", "Azure AD app credentials missing. Set microsoft.client-id / client-secret / tenant-id in chat-cleaner/application-local.properties.");
        } else {
            t.put("reason", null);
            t.put("tenantId", msTenantId);
            t.put("clientId", msClientId);
            t.put("adminEmail", notBlank(msAdminEmail) ? msAdminEmail : "(scanning all enabled users)");
        }
        out.put("teams", t);

        Map<String, Object> s = new LinkedHashMap<>();
        boolean sConfigured = notBlank(slackToken) && slackToken.startsWith("xox");
        s.put("configured", sConfigured);
        s.put("reason", sConfigured ? null : "slack.user-token is missing. Paste xoxp- token into chat-cleaner/application-local.properties.");
        s.put("teamId", slackTeamId);
        out.put("slack", s);

        return out;
    }

    private static boolean notBlank(String v) {
        return v != null && !v.isBlank();
    }
}
