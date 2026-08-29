import { describe, expect, it } from "vitest";
import { ArtifactType } from "../../src/artifacts/types.js";
import { extractReviewImages } from "../../src/providers/reviewers/shared/prompt.js";

describe("review vision artifacts", () => {
  it("extracts screenshot artifacts as Gemini vision inputs", () => {
    const images = extractReviewImages({
      artifacts: [
        {
          id: "1",
          type: ArtifactType.Screenshot,
          path: "artifacts/screenshots/help-80col.png",
          description: "Help screen",
          content: "aGVsbG8=",
          metadata: { mimeType: "image/png", encoding: "base64" },
        },
        {
          id: "2",
          type: ArtifactType.File,
          path: "src/tui/screens/help.tsx",
          content: "export {}",
        },
      ],
    });

    expect(images).toEqual([
      {
        mimeType: "image/png",
        data: "aGVsbG8=",
        label: "Help screen",
      },
    ]);
  });
});
