import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FeatureFlagsProvider, useFeatureFlag } from "./flags";

afterEach(() => {
  cleanup();
});

function Probe({ name }: { name: string }) {
  const enabled = useFeatureFlag(name);
  return <p data-testid="flag">{enabled ? "on" : "off"}</p>;
}

describe("useFeatureFlag", () => {
  it("reads the flag value from the provider", () => {
    render(
      <FeatureFlagsProvider flags={{ events: true, money: false }}>
        <Probe name="events" />
      </FeatureFlagsProvider>,
    );
    expect(screen.getByTestId("flag").textContent).toBe("on");
  });

  it("treats a missing or disabled flag as off (fail closed)", () => {
    render(
      <FeatureFlagsProvider flags={{ money: false }}>
        <Probe name="money" />
        <Probe name="unknown" />
      </FeatureFlagsProvider>,
    );
    const values = screen.getAllByTestId("flag").map((el) => el.textContent);
    expect(values).toEqual(["off", "off"]);
  });
});
