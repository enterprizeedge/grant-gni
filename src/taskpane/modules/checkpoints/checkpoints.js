/* global Word, localStorage */

// Document checkpoints — whole-body OOXML snapshots stored in localStorage,
// with quota-aware pruning. Extracted verbatim from taskpane.js (CTO review
// Rec 8: decompose the monolith); behaviour is unchanged.

import { addMessageToChat, updateSystemMessage } from "../chat/chat-ui.js";

// Storage quotas
export const STORAGE_LIMITS = {
  SAFE_LIMIT: 4500000, // ~4.5MB safe limit for localStorage
  MIN_PRUNE_COUNT: 5, // Minimum checkpoints to prune when quota exceeded
};

export function getCheckpoints() {
  const checkpointsJson = localStorage.getItem("docCheckpoints");
  return checkpointsJson ? JSON.parse(checkpointsJson) : [];
}

export function saveCheckpoints(checkpoints) {
  const MAX_RETRIES = 10; // Maximum number of retry attempts

  let retries = 0;
  while (retries < MAX_RETRIES) {
    try {
      localStorage.setItem("docCheckpoints", JSON.stringify(checkpoints));
      return true; // Success
    } catch (error) {
      if (error.name === 'QuotaExceededError' && checkpoints.length > 1) {
        // Remove 50% of checkpoints (more aggressive pruning)
        const toRemove = Math.max(1, Math.floor(checkpoints.length / 2));
        checkpoints.splice(0, toRemove);
        console.warn(`QuotaExceededError: Removed ${toRemove} oldest checkpoint(s), ${checkpoints.length} remaining. Retrying...`);
        retries++;
      } else if (error.name === 'QuotaExceededError' && checkpoints.length <= 1) {
        // Can't prune anymore, clear all and give up gracefully
        console.warn("Storage quota exceeded. Clearing all checkpoints.");
        try {
          localStorage.removeItem("docCheckpoints");
        } catch (e) { /* ignore */ }
        return false; // Silently fail rather than throw
      } else {
        // Not a quota error
        console.error("Failed to save checkpoints:", error);
        return false; // Silently fail rather than throw
      }
    }
  }

  // If we've exhausted retries, fail gracefully
  console.warn("Unable to save checkpoint after max retries. Clearing checkpoints.");
  try {
    localStorage.removeItem("docCheckpoints");
  } catch (e) { /* ignore */ }
  return false;
}

export async function createCheckpoint(silent = false) {
  if (!silent) {
    addMessageToChat("System", "Saving checkpoint...");
  }
  try {
    return await Word.run(async (context) => {
      const ooxml = context.document.body.getOoxml();
      await context.sync();

      // 'ooxml.value' is a base64 string of the entire document body
      const ooxmlLength = ooxml.value.length;
      console.log(`Checkpoint OOXML length: ${ooxmlLength}`);

      const checkpoints = getCheckpoints();

      // Check for quota issues roughly (5MB limit usually)
      let totalSize = 0;
      checkpoints.forEach(c => totalSize += c.length);
      console.log(`Current total checkpoints size: ${totalSize}`);

      let prunedCount = 0;

      // Prune at least MIN_PRUNE_COUNT checkpoints if we need to prune any, to create a buffer
      while ((totalSize + ooxmlLength > STORAGE_LIMITS.SAFE_LIMIT || (prunedCount > 0 && prunedCount < STORAGE_LIMITS.MIN_PRUNE_COUNT)) && checkpoints.length > 0) {
        const removed = checkpoints.shift(); // Remove oldest
        totalSize -= removed.length;
        prunedCount++;
      }

      if (prunedCount > 0) {
        console.warn(`LocalStorage quota exceeded. Removed ${prunedCount} oldest checkpoint(s).`);
        if (!silent) {
          addMessageToChat("System", `Storage full. Removed ${prunedCount} old checkpoint(s) to make space.`);
        }
      }

      checkpoints.push(ooxml.value);
      saveCheckpoints(checkpoints);

      if (!silent) {
        addMessageToChat("System", `Checkpoint saved. Total: ${checkpoints.length}`);
      }

      // Return the index of the newly created checkpoint (0-based)
      return checkpoints.length - 1;
    });
  } catch (error) {
    console.error("Error saving checkpoint:", error);
    if (!silent) {
      addMessageToChat("Error", `Could not save checkpoint. ${error.message}`);
    }
    return -1;
  }
}

export async function restoreCheckpoint(index) {
  const checkpoints = getCheckpoints();
  if (index < 0 || index >= checkpoints.length) {
    addMessageToChat("Error", "Invalid checkpoint index.");
    return;
  }

  const msgElement = addMessageToChat("System", `Reverting to checkpoint #${index + 1}...`);

  const targetCheckpointOoxml = checkpoints[index];

  try {
    await Word.run(async (context) => {
      // Disable Track Changes to avoid "Delete All + Insert All" redlines
      const doc = context.document;
      doc.load("changeTrackingMode");
      await context.sync();

      const originalMode = doc.changeTrackingMode;
      if (originalMode !== Word.ChangeTrackingMode.off) {
        doc.changeTrackingMode = Word.ChangeTrackingMode.off;
        await context.sync();
      }

      context.document.body.clear(); // Clear the current document body
      context.document.body.insertOoxml(targetCheckpointOoxml, "Replace");
      await context.sync();

      // Optionally restore track changes, but reverting usually implies going back to a state.
      // If we restore it, we might want to do it cleanly.
      if (originalMode !== Word.ChangeTrackingMode.off) {
        doc.changeTrackingMode = originalMode;
        await context.sync();
      }

      updateSystemMessage(msgElement, "Reverted successfully.");
    });
  } catch (error) {
    console.error("Error reverting checkpoint:", error);
    updateSystemMessage(msgElement, "Error: Could not revert checkpoint.");
  }
}
