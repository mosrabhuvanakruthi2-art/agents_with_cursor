package com.cloudfuze.chatcleaner.service;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.net.URI;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Consumer;

@Service
public class MicrosoftTeamsService {

    private static final Logger log = LoggerFactory.getLogger(MicrosoftTeamsService.class);
    private static final String GRAPH = "https://graph.microsoft.com/v1.0";

    private final RestTemplate restTemplate;

    public MicrosoftTeamsService(@Qualifier("teamsRestTemplate") RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    public List<SpaceDto> listAll(Consumer<String> onProgress) {
        List<SpaceDto> all = new ArrayList<>();
        all.addAll(listAllTeams(onProgress));
        all.addAll(listAllChats(onProgress));
        long teams = all.stream().filter(s -> "SPACE".equals(s.getSpaceType())).count();
        long chats = all.size() - teams;
        onProgress.accept("Total found: " + teams + " teams, " + chats + " chats/DMs");
        return all;
    }

    private List<SpaceDto> listAllTeams(Consumer<String> onProgress) {
        List<SpaceDto> result = new ArrayList<>();
        onProgress.accept("Fetching Teams from Microsoft Graph...");

        // ConsistencyLevel: eventual + $count=true required for resourceProvisioningOptions filter
        HttpHeaders headers = new HttpHeaders();
        headers.set("ConsistencyLevel", "eventual");
        HttpEntity<Void> entity = new HttpEntity<>(headers);

        String url = GRAPH + "/groups?$filter=resourceProvisioningOptions/Any(x:x%20eq%20'Team')"
                + "&$select=id,displayName,createdDateTime,renewedDateTime,description&$top=100&$count=true";
        do {
            try {
                log.info("Teams: GET {}", url);
                ResponseEntity<GroupsResponse> resp = restTemplate.exchange(URI.create(url), HttpMethod.GET, entity, GroupsResponse.class);
                GroupsResponse body = resp.getBody();
                if (body == null || body.getValue() == null) {
                    log.warn("Teams: empty response body");
                    break;
                }
                log.info("Teams: page returned {} groups", body.getValue().size());
                for (GroupDto g : body.getValue()) {
                    SpaceDto dto = new SpaceDto();
                    dto.setName("groups/" + g.getId());
                    dto.setDisplayName(g.getDisplayName() != null ? g.getDisplayName() : "Unnamed Team");
                    String lastActive = g.getRenewedDateTime() != null ? g.getRenewedDateTime() : g.getCreatedDateTime();
                    dto.setLastActiveTime(lastActive);
                    dto.setCreateTime(g.getCreatedDateTime());
                    dto.setSpaceType("SPACE");
                    result.add(dto);
                }
                onProgress.accept("Fetched " + result.size() + " teams so far...");
                url = body.getOdataNextLink();
            } catch (Exception e) {
                log.error("Teams: error listing teams: {}", e.getMessage());
                onProgress.accept("Error fetching teams: " + e.getMessage());
                break;
            }
        } while (url != null);
        log.info("Teams: total teams fetched = {}", result.size());
        return result;
    }

    private List<SpaceDto> listAllChats(Consumer<String> onProgress) {
        List<SpaceDto> result = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        onProgress.accept("Fetching users to enumerate chats/DMs...");
        try {
            List<UserDto> users = listAllUsers();
            onProgress.accept("Found " + users.size() + " users — fetching their chats...");
            int processed = 0;
            for (UserDto user : users) {
                try {
                    String url = GRAPH + "/users/" + user.getId() + "/chats?$top=50";
                    do {
                        ChatsResponse resp = restTemplate.getForObject(URI.create(url), ChatsResponse.class);
                        if (resp == null || resp.getValue() == null) break;
                        for (ChatDto c : resp.getValue()) {
                            if ("meeting".equals(c.getChatType())) continue;
                            if (!seen.add(c.getId())) continue; // deduplicate
                            SpaceDto dto = new SpaceDto();
                            dto.setName("chats/" + c.getId());
                            dto.setDisplayName(resolveChatName(c));
                            String lastActive = c.getLastUpdatedDateTime() != null
                                    ? c.getLastUpdatedDateTime() : c.getCreatedDateTime();
                            dto.setLastActiveTime(lastActive);
                            dto.setCreateTime(c.getCreatedDateTime());
                            dto.setSpaceType("group".equals(c.getChatType()) ? "GROUP_CHAT" : "DIRECT_MESSAGE");
                            result.add(dto);
                        }
                        url = resp.getOdataNextLink();
                    } while (url != null);
                } catch (Exception e) {
                    log.debug("Could not fetch chats for user {}: {}", user.getId(), e.getMessage());
                }
                processed++;
                if (processed % 20 == 0) {
                    onProgress.accept("Processed " + processed + "/" + users.size() + " users, " + result.size() + " chats found...");
                }
            }
        } catch (Exception e) {
            log.warn("Chats: listing failed: {}", e.getMessage());
            onProgress.accept("Warning: could not fetch chats — " + e.getMessage());
        }
        log.info("Chats: total = {}", result.size());
        return result;
    }

    private List<UserDto> listAllUsers() {
        List<UserDto> users = new ArrayList<>();
        String url = GRAPH + "/users?$select=id,displayName,mail&$filter=accountEnabled%20eq%20true&$top=100";
        do {
            try {
                UsersResponse resp = restTemplate.getForObject(URI.create(url), UsersResponse.class);
                if (resp == null || resp.getValue() == null) break;
                users.addAll(resp.getValue());
                log.info("Users: fetched {} so far...", users.size());
                url = resp.getOdataNextLink();
            } catch (Exception e) {
                log.error("Users: listing failed: {}", e.getMessage());
                break;
            }
        } while (url != null);
        log.info("Users: total = {}", users.size());
        return users;
    }

    private String resolveChatName(ChatDto c) {
        if (c.getTopic() != null && !c.getTopic().isBlank()) return c.getTopic();
        if ("oneOnOne".equals(c.getChatType())) return "Direct Message";
        if ("group".equals(c.getChatType()))    return "Group Chat";
        return "Chat";
    }

    public List<SpaceInfo> findInDateRange(List<SpaceDto> items, LocalDate start, LocalDate end) {
        List<SpaceInfo> matched = new ArrayList<>();
        for (SpaceDto item : items) {
            LocalDate createDate = parseDate(item.getCreateTime());
            LocalDate activeDate = parseDate(item.getLastActiveTime());
            if (activeDate == null) activeDate = createDate;

            boolean inRange;
            if ("SPACE".equals(item.getSpaceType())) {
                // Microsoft Graph does not expose real last-activity for groups — return all teams
                inRange = true;
            } else {
                // Chats have reliable lastUpdatedDateTime — filter strictly by range
                inRange = activeDate != null && !activeDate.isBefore(start) && !activeDate.isAfter(end);
            }

            if (inRange) {
                matched.add(new SpaceInfo(item.getName(), item.getDisplayName(), activeDate, item.getSpaceType()));
            }
        }
        long teams = matched.stream().filter(s -> "SPACE".equals(s.spaceType())).count();
        long chats = matched.size() - teams;
        log.info("Teams matched: {} teams, {} chats", teams, chats);
        return matched;
    }

    public boolean deleteItem(String resourceName) {
        if (resourceName.startsWith("chats/")) {
            return purgeChatMessages(resourceName);
        }
        try {
            restTemplate.delete(GRAPH + "/" + resourceName);
            log.info("DELETED team: {}", resourceName);
            return true;
        } catch (Exception e) {
            log.error("FAILED to delete team {}: {}", resourceName, e.getMessage());
            return false;
        }
    }

    private boolean purgeChatMessages(String chatResource) {
        // chatResource = "chats/19:xxx@thread.v2"
        try {
            String url = GRAPH + "/" + chatResource + "/messages?$top=50";
            int deleted = 0;
            do {
                MessagesResponse resp = restTemplate.getForObject(URI.create(url), MessagesResponse.class);
                if (resp == null || resp.getValue() == null) break;
                for (MessageDto msg : resp.getValue()) {
                    if (msg.getDeletedDateTime() != null) continue; // already deleted
                    if ("unknownFutureValue".equals(msg.getMessageType())) continue;
                    try {
                        restTemplate.postForObject(
                            URI.create(GRAPH + "/" + chatResource + "/messages/" + msg.getId() + "/softDelete"),
                            null, String.class);
                        deleted++;
                    } catch (Exception e) {
                        log.debug("softDelete msg {} in {}: {}", msg.getId(), chatResource, e.getMessage());
                    }
                }
                url = resp.getOdataNextLink();
            } while (url != null);
            log.info("Purged {} messages from {}", deleted, chatResource);
            return true;
        } catch (Exception e) {
            log.error("FAILED to purge chat {}: {}", chatResource, e.getMessage());
            return false;
        }
    }

    private LocalDate parseDate(String dateStr) {
        if (dateStr == null || dateStr.isBlank()) return null;
        try {
            return OffsetDateTime.parse(dateStr, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toLocalDate();
        } catch (Exception e) {
            return null;
        }
    }

    // ── DTOs ─────────────────────────────────────────────────────────────────

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class SpaceDto {
        private String name, displayName, lastActiveTime, createTime, spaceType;
        public String getName()            { return name; }
        public void   setName(String v)    { name = v; }
        public String getDisplayName()     { return displayName; }
        public void   setDisplayName(String v) { displayName = v; }
        public String getLastActiveTime()  { return lastActiveTime; }
        public void   setLastActiveTime(String v) { lastActiveTime = v; }
        public String getCreateTime()      { return createTime; }
        public void   setCreateTime(String v) { createTime = v; }
        public String getSpaceType()       { return spaceType; }
        public void   setSpaceType(String v) { spaceType = v; }
    }

    public record SpaceInfo(String name, String displayName, LocalDate lastActivity, String spaceType) {
        public String lastActivityStr() {
            return lastActivity != null ? lastActivity.toString() : "No activity";
        }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class GroupsResponse {
        private List<GroupDto> value;
        @JsonProperty("@odata.nextLink") private String odataNextLink;
        public List<GroupDto> getValue()        { return value; }
        public void           setValue(List<GroupDto> v) { value = v; }
        public String         getOdataNextLink() { return odataNextLink; }
        public void           setOdataNextLink(String v) { odataNextLink = v; }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class GroupDto {
        private String id, displayName, createdDateTime, renewedDateTime, description;
        public String getId()                    { return id; }
        public void   setId(String v)            { id = v; }
        public String getDisplayName()           { return displayName; }
        public void   setDisplayName(String v)   { displayName = v; }
        public String getCreatedDateTime()       { return createdDateTime; }
        public void   setCreatedDateTime(String v) { createdDateTime = v; }
        public String getRenewedDateTime()       { return renewedDateTime; }
        public void   setRenewedDateTime(String v) { renewedDateTime = v; }
        public String getDescription()           { return description; }
        public void   setDescription(String v)   { description = v; }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ChatsResponse {
        private List<ChatDto> value;
        @JsonProperty("@odata.nextLink") private String odataNextLink;
        public List<ChatDto> getValue()        { return value; }
        public void          setValue(List<ChatDto> v) { value = v; }
        public String        getOdataNextLink() { return odataNextLink; }
        public void          setOdataNextLink(String v) { odataNextLink = v; }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class UsersResponse {
        private List<UserDto> value;
        @JsonProperty("@odata.nextLink") private String odataNextLink;
        public List<UserDto> getValue()        { return value; }
        public void          setValue(List<UserDto> v) { value = v; }
        public String        getOdataNextLink() { return odataNextLink; }
        public void          setOdataNextLink(String v) { odataNextLink = v; }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class UserDto {
        private String id, displayName, mail;
        public String getId()            { return id; }
        public void   setId(String v)    { id = v; }
        public String getDisplayName()   { return displayName; }
        public void   setDisplayName(String v) { displayName = v; }
        public String getMail()          { return mail; }
        public void   setMail(String v)  { mail = v; }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ChatDto {
        private String id, chatType, topic, createdDateTime, lastUpdatedDateTime;
        public String getId()                    { return id; }
        public void   setId(String v)            { id = v; }
        public String getChatType()              { return chatType; }
        public void   setChatType(String v)      { chatType = v; }
        public String getTopic()                 { return topic; }
        public void   setTopic(String v)         { topic = v; }
        public String getCreatedDateTime()       { return createdDateTime; }
        public void   setCreatedDateTime(String v) { createdDateTime = v; }
        public String getLastUpdatedDateTime()   { return lastUpdatedDateTime; }
        public void   setLastUpdatedDateTime(String v) { lastUpdatedDateTime = v; }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class MessagesResponse {
        private List<MessageDto> value;
        @JsonProperty("@odata.nextLink") private String odataNextLink;
        public List<MessageDto> getValue()        { return value; }
        public void             setValue(List<MessageDto> v) { value = v; }
        public String           getOdataNextLink() { return odataNextLink; }
        public void             setOdataNextLink(String v) { odataNextLink = v; }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class MessageDto {
        private String id, messageType, deletedDateTime;
        public String getId()                      { return id; }
        public void   setId(String v)              { id = v; }
        public String getMessageType()             { return messageType; }
        public void   setMessageType(String v)     { messageType = v; }
        public String getDeletedDateTime()         { return deletedDateTime; }
        public void   setDeletedDateTime(String v) { deletedDateTime = v; }
    }
}
