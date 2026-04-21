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

import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;

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

    @Bean
    public GoogleCredentials googleCredentials() throws IOException {
        ServiceAccountCredentials base = ServiceAccountCredentials.fromStream(new FileInputStream(keyPath));
        log.info("Loaded service account: {}", base.getClientEmail());
        log.info("Delegating as admin   : {}", adminEmail);
        log.info("Requesting scopes     : {}", SCOPES);

        return base.toBuilder()
                .setScopes(SCOPES)
                .setServiceAccountUser(adminEmail)
                .build();
    }

    @Bean
    public RestTemplate restTemplate(GoogleCredentials credentials) {
        RestTemplate restTemplate = new RestTemplate();

        ClientHttpRequestInterceptor authInterceptor = (request, body, execution) -> {
            credentials.refreshIfExpired();
            String token = credentials.getAccessToken().getTokenValue();

            // Decode JWT payload to log actual scopes in the token
            try {
                String[] parts = token.split("\\.");
                if (parts.length >= 2) {
                    String payload = new String(Base64.getUrlDecoder().decode(parts[1]), StandardCharsets.UTF_8);
                    log.info("Token payload: {}", payload);
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
