package com.cloudfuze.chatcleaner.service;

import com.opencsv.CSVWriter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.FileWriter;
import java.io.IOException;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;

@Service
public class ReportService {

    private static final Logger log = LoggerFactory.getLogger(ReportService.class);

    public String generateCsvReport(List<GoogleChatService.SpaceInfo> spaces, boolean dryRun) {
        String timestamp = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd_HHmmss"));
        String fileName = "chat_spaces_" + (dryRun ? "preview" : "deleted") + "_" + timestamp + ".csv";

        try (CSVWriter writer = new CSVWriter(new FileWriter(fileName))) {
            writer.writeNext(new String[]{"Space Name (ID)", "Display Name", "Last Activity Date", "Status"});
            for (GoogleChatService.SpaceInfo space : spaces) {
                writer.writeNext(new String[]{
                        space.name(),
                        space.displayName(),
                        space.lastActivityStr(),
                        dryRun ? "WOULD BE DELETED" : "DELETED"
                });
            }
            log.info("Report saved: {}", fileName);
            return fileName;
        } catch (IOException e) {
            log.error("Failed to write CSV report: {}", e.getMessage());
            return null;
        }
    }

    public void printSummaryTable(List<GoogleChatService.SpaceInfo> spaces,
                                   LocalDate startDate, LocalDate endDate, boolean dryRun) {
        System.out.println("\n" + "=".repeat(80));
        System.out.printf("  Google Chat Space Cleaner — %s Mode%n", dryRun ? "DRY RUN (preview)" : "LIVE DELETE");
        System.out.println("  Date Range : " + startDate + "  to  " + endDate);
        System.out.println("=".repeat(80));

        if (spaces.isEmpty()) {
            System.out.println("  No spaces found with last activity in the given date range.");
        } else {
            System.out.printf("  %-45s %-20s %-15s%n", "Space Display Name", "Last Activity", "Action");
            System.out.println("-".repeat(80));
            for (GoogleChatService.SpaceInfo space : spaces) {
                System.out.printf("  %-45s %-20s %-15s%n",
                        truncate(space.displayName(), 43),
                        space.lastActivityStr(),
                        dryRun ? "WOULD DELETE" : "DELETED");
            }
        }

        System.out.println("=".repeat(80));
        System.out.printf("  Total: %d space(s) %s%n",
                spaces.size(), dryRun ? "would be deleted" : "deleted");
        System.out.println("=".repeat(80) + "\n");
    }

    private String truncate(String text, int maxLen) {
        if (text == null) return "";
        return text.length() > maxLen ? text.substring(0, maxLen - 2) + ".." : text;
    }
}
