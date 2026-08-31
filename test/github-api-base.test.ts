import { afterEach, describe, expect, test } from "vitest";
import { githubApiBase } from "../src/core/github-manager.js";

const previous = process.env.NOMOREIDE_GITHUB_API_BASE;

afterEach(() => {
  if (previous === undefined) delete process.env.NOMOREIDE_GITHUB_API_BASE;
  else process.env.NOMOREIDE_GITHUB_API_BASE = previous;
});

describe("githubApiBase", () => {
  test("defaults to GitHub", () => {
    delete process.env.NOMOREIDE_GITHUB_API_BASE;
    expect(githubApiBase()).toBe("https://api.github.com");
  });

  test("accepts a loopback override, trailing slash and all", () => {
    process.env.NOMOREIDE_GITHUB_API_BASE = "http://127.0.0.1:8080/";
    expect(githubApiBase()).toBe("http://127.0.0.1:8080");
    process.env.NOMOREIDE_GITHUB_API_BASE = "http://localhost:1";
    expect(githubApiBase()).toBe("http://localhost:1");
  });

  /**
   * Every request through this base carries a bearer token. An override that
   * could name any host would turn one environment variable into a way to post
   * the user's credential somewhere else, so anything but loopback is ignored
   * rather than obeyed.
   */
  test("ignores an override that is not loopback", () => {
    for (const value of [
      "http://attacker.example",
      "https://api.github.com.evil.example",
      "http://127.0.0.1.evil.example",
      "ftp://127.0.0.1",
      "not a url",
      "   ",
    ]) {
      process.env.NOMOREIDE_GITHUB_API_BASE = value;
      expect(githubApiBase(), value).toBe("https://api.github.com");
    }
  });
});
