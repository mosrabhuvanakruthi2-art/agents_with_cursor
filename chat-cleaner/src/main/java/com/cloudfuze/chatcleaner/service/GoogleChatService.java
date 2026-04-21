package com.cloudfuze.chatcleaner.service;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

@Service
public class GoogleChatService {

    private static final Logger log = LoggerFactory.getLogger(GoogleChatService.class);
    private static final String BASE_URL = "https://chat.googleapis.com/v1";

    private final RestTemplate restTemplate;

    public GoogleChatService(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    public List<SpaceDto> listAllSpaces() {
        return listAllSpaces(msg -> log.info(msg));
    }

    public List<SpaceDto> listAllSpaces(Consumer<String> onProgress) {
        List<SpaceDto> allItems = new ArrayList<>();
        String pageToken = null;

        onProgress.accept("Fetching all spaces and DMs from Google Chat...");
        do {
            UriComponentsBuilder uri = UriComponentsBuilder.fromHttpUrl(BASE_URL + "/spaces")
                    .queryParam("pageSize", 100);

            if (pageToken != null) {
                uri.queryParam("pageToken", pageToken);
            }

            ListSpacesResponse response = restTemplate.getForObject(uri.build().toUri(), ListSpacesResponse.class);
            if (response != null && response.getSpaces() != null) {
                allItems.addAll(response.getSpaces());
                onProgress.accept("Fetched " + allItems.size() + " items so far...");
                pageToken = response.getNextPageToken();
            } else {
                break;
            }
        } while (pageToken != null);

        long spaces = allItems.stream().filter(s -> "SPACE".equals(s.getSpaceType())).count();
        long dms = allItems.stream().filter(s -> !"SPACE".equals(s.getSpaceType())).count();
        onProgress.accept("Total found: " + spaces + " spaces, " + dms + " DMs/group chats");
        return allItems;
    }

    public List<SpaceInfo> findInDateRange(List<SpaceDto> items, LocalDate startDate, LocalDate endDate) {
        List<SpaceInfo> matched = new ArrayList<>();
        log.info("Filtering items with last activity between {} and {}...", startDate, endDate);

        for (SpaceDto space : items) {
            String type = space.getSpaceType() != null ? space.getSpaceType() : "UNKNOWN";
            String displayName = resolveDisplayName(space);

            // Use lastActiveTime first, fall back to createTime
            LocalDate activeDate = parseDate(space.getLastActiveTime());
            if (activeDate == null) {
                activeDate = parseDate(space.getCreateTime());
            }

            boolean inRange = activeDate != null
                    && !activeDate.isBefore(startDate)
                    && !activeDate.isAfter(endDate);

            if (inRange) {
                matched.add(new SpaceInfo(space.getName(), displayName, activeDate, type));
            }
        }

        long spaces = matched.stream().filter(s -> "SPACE".equals(s.spaceType())).count();
        long dms = matched.size() - spaces;
        log.info("Matched: {} spaces, {} DMs/group chats", spaces, dms);
        return matched;
    }

    private LocalDate parseDate(String dateStr) {
        if (dateStr == null || dateStr.isBlank()) return null;
        try {
            return OffsetDateTime.parse(dateStr, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toLocalDate();
        } catch (Exception e) {
            return null;
        }
    }

    private String resolveDisplayName(SpaceDto space) {
        if (space.getDisplayName() != null && !space.getDisplayName().isBlank()) {
            return space.getDisplayName();
        }
        if ("DIRECT_MESSAGE".equals(space.getSpaceType())) return "Direct Message";
        if ("GROUP_CHAT".equals(space.getSpaceType())) return "Group Chat";
        return space.getName();
    }

    public boolean deleteSpace(String spaceName) {
        try {
            String url = UriComponentsBuilder.fromHttpUrl(BASE_URL + "/" + spaceName)
                    .queryParam("useAdminAccess", true)
                    .toUriString();
            restTemplate.delete(url);
            log.info("  DELETED: {}", spaceName);
            return true;
        } catch (Exception e) {
            log.error("  FAILED to delete {}: {}", spaceName, e.getMessage());
            return false;
        }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ListSpacesResponse {
        private List<SpaceDto> spaces;
        private String nextPageToken;

        public List<SpaceDto> getSpaces() { return spaces; }
        public void setSpaces(List<SpaceDto> spaces) { this.spaces = spaces; }
        public String getNextPageToken() { return nextPageToken; }
        public void setNextPageToken(String t) { this.nextPageToken = t; }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class SpaceDto {
        private String name;
        private String displayName;
        @JsonProperty("lastActiveTime")
        private String lastActiveTime;
        @JsonProperty("createTime")
        private String createTime;
        private String spaceType;

        public String getName() { return name; }
        public void setName(String name) { this.name = name; }
        public String getDisplayName() { return displayName; }
        public void setDisplayName(String d) { this.displayName = d; }
        public String getLastActiveTime() { return lastActiveTime; }
        public void setLastActiveTime(String t) { this.lastActiveTime = t; }
        public String getCreateTime() { return createTime; }
        public void setCreateTime(String t) { this.createTime = t; }
        public String getSpaceType() { return spaceType; }
        public void setSpaceType(String t) { this.spaceType = t; }
    }

    public record SpaceInfo(String name, String displayName, LocalDate lastActivity, String spaceType) {
        public String lastActivityStr() {
            return lastActivity != null ? lastActivity.toString() : "No activity";
        }
    }
}
