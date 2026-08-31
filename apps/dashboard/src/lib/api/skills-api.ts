export interface RemoteSkillResult {
  id: string;
  name: string;
  source: string;
  useSource: string;
  installs: number;
  url: string;
}

export interface OneTimeSkillSelection {
  name: string;
  source: string;
}

export interface SkillsApi {
  loadOneTimeSkillPrompt(skill: OneTimeSkillSelection): Promise<string>;
  searchSkills(query: string): Promise<RemoteSkillResult[]>;
}
