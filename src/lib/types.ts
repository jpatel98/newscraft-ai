export type SiteScope = {
  allowedDomains: string[];
  preferredUrls: string[];
};

export type ExpertSource = {
  title: string;
  url: string;
};

export type ExpertCandidate = {
  name: string;
  role: string;
  organization: string;
  location: string;
  whyRelevant: string;
  reachoutAngle: string;
  bookingSignal: "strong" | "solid" | "speculative";
  sources: ExpertSource[];
};

export type ExpertiseFinderResult = {
  brief: string;
  summary: string;
  editorialAngle: string;
  confidence: "high" | "medium" | "low";
  experts: ExpertCandidate[];
  nextMoves: string[];
  watchouts: string[];
};
