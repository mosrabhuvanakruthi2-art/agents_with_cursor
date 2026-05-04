package com.cloudfuze.chatcleaner.config;

import com.microsoft.aad.msal4j.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestTemplate;

import java.util.Collections;

@Configuration
public class MicrosoftTeamsConfig {

    private static final Logger log = LoggerFactory.getLogger(MicrosoftTeamsConfig.class);

    @Value("${microsoft.tenant-id:}")     private String tenantId;
    @Value("${microsoft.client-id:}")     private String clientId;
    @Value("${microsoft.client-secret:}") private String clientSecret;
    @Value("${microsoft.admin.email:}")   private String adminEmail;

    @Bean(name = "teamsRestTemplate")
    public RestTemplate teamsRestTemplate() throws Exception {
        if (tenantId == null || tenantId.isBlank() || tenantId.equals("YOUR_TENANT_ID")) {
            log.warn("Teams: microsoft.tenant-id not configured — Teams features disabled");
            return new RestTemplate();
        }
        if (clientId == null || clientId.isBlank()) {
            log.warn("Teams: microsoft.client-id not configured — Teams features disabled");
            return new RestTemplate();
        }
        if (clientSecret == null || clientSecret.isBlank()) {
            log.warn("Teams: microsoft.client-secret not configured — set MICROSOFT_CLIENT_SECRET or microsoft.client-secret");
            return new RestTemplate();
        }

        // Client credentials: scope ".default" uses every application permission
        // granted + admin-consented on this app (User, Group, Chat, etc.).
        ConfidentialClientApplication app = ConfidentialClientApplication
                .builder(clientId, ClientCredentialFactory.createFromSecret(clientSecret))
                .authority("https://login.microsoftonline.com/" + tenantId)
                .build();
        log.info("Teams: MSAL using https://graph.microsoft.com/.default (all consented app roles)");
        log.info("Teams: tenant={}, client id={}", tenantId, clientId);
        log.info("Teams: admin email (reference): {}", adminEmail);

        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(15000);
        factory.setReadTimeout(120000);
        RestTemplate rt = new RestTemplate(factory);
        rt.getInterceptors().add((request, body, execution) -> {
            try {
                ClientCredentialParameters params = ClientCredentialParameters
                        .builder(Collections.singleton("https://graph.microsoft.com/.default"))
                        .build();
                IAuthenticationResult result = app.acquireToken(params).get();
                request.getHeaders().setBearerAuth(result.accessToken());
            } catch (Exception e) {
                log.error("Teams: failed to acquire access token: {}", e.getMessage());
                throw new IllegalStateException(
                        "Microsoft Graph token failed. Check tenant-id, client-id, client-secret, and admin consent on application permissions.",
                        e);
            }
            return execution.execute(request, body);
        });
        return rt;
    }
}
