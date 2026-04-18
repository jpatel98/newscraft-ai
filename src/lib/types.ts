export type SiteScope = {
  allowedDomains: string[];
  preferredUrls: string[];
};

export type ExpertSource = {
  title: string;
  url: string;
};

export type ExpertContactLink = {
  label: string;
  value: string;
};

export type ExpertCandidate = {
  name: string;
  role: string;
  organization: string;
  whyRelevant: string;
  email: string;
  phone: string;
  website: string;
  socials: ExpertContactLink[];
  otherLinks: ExpertSource[];
  source: ExpertSource;
  contactNote: string;
};

export type ExpertiseFinderResult = {
  topic: string;
  storyAngle: string;
  summary: string;
  confidence: "high" | "medium" | "low";
  experts: ExpertCandidate[];
  nextMoves: string[];
  watchouts: string[];
};
