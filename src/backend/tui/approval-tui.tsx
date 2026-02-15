import React, { useState, useEffect } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import type { ApprovalService } from "../auth/approval-service.js";
import type { PendingConnection } from "../auth/approval-types.js";

interface ApprovalAppProps {
  service: ApprovalService;
}

const timeAgo = (timestamp: number): string => {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
};

const truncate = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 1) + "\u2026";
};

const ApprovalApp: React.FC<ApprovalAppProps> = ({ service }) => {
  const [pending, setPending] = useState<PendingConnection[]>(service.getPending());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [, setTick] = useState(0);
  const { exit } = useApp();

  useEffect(() => {
    const refresh = (): void => {
      setPending(service.getPending());
    };

    service.on("pending-added", refresh);
    service.on("approved", refresh);
    service.on("denied", refresh);
    service.on("pending-removed", refresh);

    return () => {
      service.off("pending-added", refresh);
      service.off("approved", refresh);
      service.off("denied", refresh);
      service.off("pending-removed", refresh);
    };
  }, [service]);

  // Keep time-ago labels updating
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(interval);
  }, []);

  // Clamp selected index
  useEffect(() => {
    if (selectedIndex >= pending.length) {
      setSelectedIndex(Math.max(0, pending.length - 1));
    }
  }, [pending.length, selectedIndex]);

  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setSelectedIndex((i) => Math.min(pending.length - 1, i + 1));
    } else if (input === "a" && pending.length > 0) {
      const connection = pending[selectedIndex];
      if (connection) {
        void service.approve(connection.id);
      }
    } else if (input === "d" && pending.length > 0) {
      const connection = pending[selectedIndex];
      if (connection) {
        service.deny(connection.id);
      }
    } else if (input === "q") {
      exit();
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Connection Approval
        </Text>
        <Text dimColor> | </Text>
        <Text dimColor>
          {"\u2191\u2193"} navigate {"  "}
          <Text color="green">a</Text> approve {"  "}
          <Text color="red">d</Text> deny {"  "}
          <Text dimColor>q</Text> quit
        </Text>
      </Box>

      {pending.length === 0 ? (
        <Text dimColor>No pending connections</Text>
      ) : (
        pending.map((connection, index) => {
          const isSelected = index === selectedIndex;
          return (
            <Box key={connection.id}>
              <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                {isSelected ? "\u25B6 " : "  "}
                [{connection.challengeCode}] {connection.ip}
                {connection.geoLocation !== "Unknown" ? ` (${connection.geoLocation})` : ""}
                {" \u2014 "}
                {truncate(connection.userAgent, 40)}
                {" \u2014 "}
                {timeAgo(connection.timestamp)}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
};

export const renderApprovalTui = (service: ApprovalService): void => {
  render(<ApprovalApp service={service} />);
};
