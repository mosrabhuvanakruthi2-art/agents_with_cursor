package com.cloudfuze.chatcleaner.config;

import com.google.auth.oauth2.GoogleCredentials;
import com.google.auth.oauth2.ServiceAccountCredentials;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.ClientHttpRequestInterceptor;
import org.springframework.web.client.RestTemplate;

import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;

/**
 * Google Chat (domain-wide-delegation) credentials. Fails gracefully: if the
 * service-account JSON is missing or invalid the app still starts and the
 * Google Chat cleaner is reported as "not configured" via {@link #isConfigured()}.
 * All other cleaners (Slack, Teams) remain usable.
 */
@Configuration
public class GoogleConfig {

    private static final Logger log = LoggerFactory.getLogger(GoogleConfig.class);

    private static final List<String> SCOPES = List.of(
            "https://www.googleapis.com/auth/chat.admin.spaces",
            "https://www.googleapis.com/auth/chat.admin.spaces.readonly",
            "https://www.googleapis.com/auth/chat.admin.delete",
            "https://www.googleapis.com/auth/chat.spaces",
            "https://www.googleapis.com/auth/chat.spaces.readonly",
            "https://www.googleapis.com/auth/chat.delete"
    );

    @Value("${google.service-account.key-path}")
    private String keyPath;

    @Value("${google.admin.email}")
    private String adminEmail;

    /** null when Google Chat cleaner is usable; otherwise a user-facing reason. */
    private String disabledReason;

    public String getDisabledReason() { return disabledReason; }
    public boolean isConfigured()     { return disabledReason == null; }

    @Bean
    public GoogleCredentials googleCredentials() {
        File f = new File(keyPath);
        if (!f.exists() || f.length() < 200) {
            disabledReason = "Google service-account JSON not found at " + f.getAbsolutePath()
                    + ". Place a real service-account key there and restart the cleaner.";
            log.warn("[gchat] Disabled: {}", disabledReason);
            return null;
        }
        try (FileInputStream in = new FileInputStream(f)) {
            ServiceAccountCredentials base = ServiceAccountCredentials.fromStream(in);
            log.info("Loaded service account: {}", base.getClientEmail());
            log.info("Delegating as admin   : {}", adminEmail);
            log.info("Requesting scopes     : {}", SCOPES);
            return base.toBuilder()
                    .setScopes(SCOPES)
                    .setServiceAccountUser(adminEmail)
                    .build();
        } catch (Exception e) {
            disabledReason = "invalid service-account JSON (" + e.getMessage()
                    + "). Replace " + f.getAbsolutePath() + " with a real Google service-account key.";
            log.warn("[gchat] Disabled: {}", disabledReason);
            return null;
        }
    }

    @Bean
    public RestTemplate restTemplate(org.springframework.beans.factory.ObjectProvider<GoogleCredentials> credsProvider) {
        RestTemplate restTemplate = new RestTemplate();
        ClientHttpRequestInterceptor authInterceptor = (request, body, execution) -> {
            GoogleCredentials credentials = credsProvider.getIfAvailable();
            if (credentials == null || !isConfigured()) {
                throw new IllegalStateException("Google Chat cleaner is not configured: "
                        + (disabledReason != null ? disabledReason : "credentials unavailable"));
            }
            credentials.refreshIfExpired();
            String token = credentials.getAccessToken().getTokenValue();
            try {
                String[] parts = token.split("\\.");
                if (parts.length >= 2) {
                    String payload = new String(Base64.getUrlDecoder().decode(parts[1]), StandardCharsets.UTF_8);
                    log.debug("Token payload: {}", payload);
                }
            } catch (Exception e) {
                log.debug("Could not decode token: {}", e.getMessage());
            }
            request.getHeaders().setBearerAuth(token);
            return execution.execute(request, body);
        };
        restTemplate.setInterceptors(List.of(authInterceptor));
        return restTemplate;
    }
}
