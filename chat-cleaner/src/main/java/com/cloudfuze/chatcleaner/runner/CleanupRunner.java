package com.cloudfuze.chatcleaner.runner;

import com.cloudfuze.chatcleaner.service.GoogleChatService;
import com.cloudfuze.chatcleaner.service.GoogleChatService.SpaceDto;
import com.cloudfuze.chatcleaner.service.GoogleChatService.SpaceInfo;
import com.cloudfuze.chatcleaner.service.ReportService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.Scanner;

public class CleanupRunner implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(CleanupRunner.class);

    private final GoogleChatService chatService;
    private final ReportService reportService;

    @Value("${app.dry-run:true}")
    private boolean dryRun;

    public CleanupRunner(GoogleChatService chatService, ReportService reportService) {
        this.chatService = chatService;
        this.reportService = reportService;
    }

    @Override
    public void run(ApplicationArguments args) throws Exception {
        System.out.println("\n====================================");
        System.out.println("  Google Chat Space Cleaner");
        System.out.println("====================================\n");

        LocalDate startDate = getDate(args, "startDate", "Enter start date (YYYY-MM-DD): ");
        if (startDate == null) return;

        LocalDate endDate = getDate(args, "endDate", "Enter end date   (YYYY-MM-DD): ");
        if (endDate == null) return;

        if (endDate.isBefore(startDate)) {
            System.err.println("End date must be after start date.");
            return;
        }

        System.out.println("Start date : " + startDate);
        System.out.println("End date   : " + endDate);
        System.out.println("Mode       : " + (dryRun ? "DRY RUN (preview — nothing deleted)" : "LIVE DELETE"));
        System.out.println();

        List<SpaceDto> allSpaces = chatService.listAllSpaces();
        if (allSpaces.isEmpty()) {
            System.out.println("No spaces found in the domain.");
            return;
        }

        List<SpaceInfo> matchedSpaces = chatService.findInDateRange(allSpaces, startDate, endDate);
        reportService.printSummaryTable(matchedSpaces, startDate, endDate, dryRun);

        if (matchedSpaces.isEmpty()) {
            System.out.println("No spaces found in the given date range. Exiting.");
            return;
        }

        String previewFile = reportService.generateCsvReport(matchedSpaces, true);
        System.out.println("Preview report saved: " + previewFile);

        if (dryRun) {
            System.out.println("\nDRY RUN mode ON. Set app.dry-run=false in application.properties to actually delete.");
            return;
        }

        if (!confirmDeletion(matchedSpaces.size())) {
            System.out.println("Deletion cancelled.");
            return;
        }

        System.out.println("\nDeleting spaces...\n");
        int success = 0, failed = 0;
        for (SpaceInfo space : matchedSpaces) {
            if (chatService.deleteSpace(space.name())) success++;
            else failed++;
        }

        System.out.printf("%nDone. Deleted: %d | Failed: %d%n", success, failed);
        String deleteReport = reportService.generateCsvReport(matchedSpaces, false);
        System.out.println("Deletion report saved: " + deleteReport);
    }

    private LocalDate getDate(ApplicationArguments args, String argName, String prompt) {
        if (args.containsOption(argName)) {
            String val = args.getOptionValues(argName).get(0);
            try {
                return LocalDate.parse(val, DateTimeFormatter.ISO_LOCAL_DATE);
            } catch (DateTimeParseException e) {
                System.err.println("Invalid date for --" + argName + ": use YYYY-MM-DD");
                return null;
            }
        }
        Scanner scanner = new Scanner(System.in);
        System.out.print(prompt);
        String input = scanner.nextLine().trim();
        try {
            return LocalDate.parse(input, DateTimeFormatter.ISO_LOCAL_DATE);
        } catch (DateTimeParseException e) {
            System.err.println("Invalid date format. Use YYYY-MM-DD (e.g. 2024-01-01)");
            return null;
        }
    }

    private boolean confirmDeletion(int count) {
        Scanner scanner = new Scanner(System.in);
        System.out.printf("%nWARNING: This will permanently delete %d space(s). This cannot be undone!%n", count);
        System.out.print("Type 'DELETE' to confirm: ");
        return "DELETE".equals(scanner.nextLine().trim());
    }
}
