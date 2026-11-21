import type { Team } from '../types/schema.js';

/** The most members any team may hold: create_team's default and the ceiling for every maxSize. */
export const MAX_TEAM_MEMBERS = 10;

/**
 * The seats a team really has: its maxSize, never more than MAX_TEAM_MEMBERS.
 * A team persisted with a larger maxSize keeps every current member, but admits
 * no new one past the cap.
 */
export function teamSeatLimit(team: Pick<Team, 'maxSize'>): number {
  return Math.min(team.maxSize, MAX_TEAM_MEMBERS);
}
