import React from "react";
import { Box, Text } from "ink";
import type { UpdateCheckResult } from "../../self/index.js";
import { Dialog } from "../components/dialog.js";
import { MenuList } from "./shared.js";

export function SystemScreen({
  selected,
  focused,
  updateInfo,
  version,
  dialog,
  confirmSelected,
}: {
  selected: number;
  focused: boolean;
  updateInfo: UpdateCheckResult | null;
  version: string;
  dialog: "none" | "confirm-uninstall";
  confirmSelected: number;
}) {
  const updateLabel = (() => {
    if (updateInfo?.updateAvailable && updateInfo.latest) {
      return `Update Assentor  ·  v${updateInfo.latest} available`;
    }
    if (updateInfo?.latest && updateInfo.message.includes("ahead")) {
      return `Update Assentor  ·  v${version} (local ahead)`;
    }
    if (updateInfo && !updateInfo.updateAvailable && updateInfo.latest) {
      return `Update Assentor  ·  up to date (v${version})`;
    }
    return `Update Assentor  ·  v${version}`;
  })();

  if (dialog === "confirm-uninstall") {
    return (
      <Dialog title="Confirm uninstall">
        <Text>Remove the `assentor` command from ~/.local/bin?</Text>
        <Text dimColor>Project .assentor/ folders (keys, tasks) are kept.</Text>
        <Box marginTop={1}>
          <MenuList
            items={["Yes, uninstall CLI", "Cancel"]}
            selected={confirmSelected}
            focused
          />
        </Box>
      </Dialog>
    );
  }

  return (
    <Box flexDirection="column">
      {updateInfo?.updateAvailable ? (
        <Text color="yellow" bold>
          ↑ Update available: v{updateInfo.local} → v{updateInfo.latest}
        </Text>
      ) : null}
      <MenuList
        focused={focused}
        selected={selected}
        items={[updateLabel, "Uninstall Assentor", "Exit"]}
      />
    </Box>
  );
}
