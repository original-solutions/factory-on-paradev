import { describe, expect, it } from "vitest";

import { addProjectCommand } from "./projects.ts";

describe("addProjectCommand", () => {
  it("names the project after the clone's folder", () => {
    expect(addProjectCommand("/Users/me/factory-runner/acme/widgets")).toBe(
      "superset projects create --local --name widgets --import /Users/me/factory-runner/acme/widgets",
    );
  });

  it("quotes a name or path a shell would split or expand", () => {
    expect(addProjectCommand("/Users/me/My Repos/it's here")).toBe(
      "superset projects create --local --name 'it'\\''s here' --import '/Users/me/My Repos/it'\\''s here'",
    );
  });
});
