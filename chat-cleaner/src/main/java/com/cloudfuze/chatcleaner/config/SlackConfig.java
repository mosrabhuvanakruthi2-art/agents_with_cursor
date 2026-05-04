package com.cloudfuze.chatcleaner.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestTemplate;

/**
 * Dedicated {@link RestTemplate} for the Slack Web API. Injects
 * {@code Authorization: Bearer <user token>} on every request. The user token
 * ({@code xoxp-...}) is required on Business+ because most list / write
 * methods (private channels, DMs, archive, chat.delete) are not available to
 * bot tokens.
 */
@Configuration
public class SlackConfig {

    private static final Logger log = LoggerFactory.getLogger(SlackConfig.class);

    @Value("${slack.user-token:}") private String userToken;
    @Value("${slack.bot-token:}")  private String botToken;

    @Bean(name = "slackRestTemplate")
    public RestTemplate slackRestTemplate() {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(15000);
        factory.setReadTimeout(120000);
        RestTemplate rt = new RestTemplate(factory);

        // Prefer the user token (xoxp) — only it can list private channels / DMs and archive/close them.
        String token = (userToken != null && !userToken.isBlank()) ? userToken : botToken;
        if (token == null || token.isBlank()) {
            log.warn("Slack: no token configured — set slack.user-token (xoxp-...) in application-local.properties or SLACK_USER_TOKEN env var. Slack features disabled.");
            return rt;
        }
        String preview = token.length() > 12 ? token.substring(0, 8) + "..." + token.substring(token.length() - 4) : "***";
        log.info("Slack: using {} token {}", token.startsWith("xoxp-") ? "user" : token.startsWith("xoxb-") ? "bot" : "unknown", preview);

        final String bearer = token;
        rt.getInterceptors().add((request, body, execution) -> {
            request.getHeaders().setBearerAuth(bearer);
            return execution.execute(request, body);
        });
        return rt;
    }
}
