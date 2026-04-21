package com.cloudfuze.chatcleaner.config;

import com.microsoft.aad.msal4j.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
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

        ConfidentialClientApplication app = ConfidentialClientApplication
                .builder(clientId, ClientCredentialFactory.createFromSecret(clientSecret))
                .authority("https://login.microsoftonline.com/" + tenantId)
                .build();
        log.info("Teams: MSAL4J initialized — tenant={}, client={}", tenantId, clientId);
        log.info("Teams: Admin account   : {}", adminEmail);

        RestTemplate rt = new RestTemplate();
        rt.getInterceptors().add((request, body, execution) -> {
            try {
                ClientCredentialParameters params = ClientCredentialParameters
                        .builder(Collections.singleton("https://graph.microsoft.com/.default"))
                        .build();
                // MSAL4J caches the token internally; only fetches new one when expired
                IAuthenticationResult result = app.acquireToken(params).get();
                request.getHeaders().setBearerAuth(result.accessToken());
            } catch (Exception e) {
                log.error("Teams: failed to acquire access token: {}", e.getMessage());
            }
            return execution.execute(request, body);
        });
        return rt;
    }
}
