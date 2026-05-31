import { mergeToolBudget, type ToolBudget } from './budget.js';
import { routeNewsroomRequest, type RouteDecision } from './router.js';
import type { NewsroomRole } from './roles.js';

export interface AssignmentDeskDecision {
	command: string;
	command_excerpt: string;
	role: NewsroomRole;
	route: RouteDecision;
	event: {
		agent: 'assignment_desk';
		kind: 'assignment.triaged';
		payload: AssignmentDeskEventPayload;
	};
}

export interface AssignmentDeskEventPayload {
	command_excerpt: string;
	routed_role: NewsroomRole;
	selected_mode: RouteDecision['selected_mode'];
	tools_to_use: string[];
	reason: string;
	expected_output: string;
}

export interface AssignmentDeskOptions {
	default_tool_budget?: Partial<ToolBudget>;
}

export class AssignmentDesk {
	triage(command: string, options: AssignmentDeskOptions = {}): AssignmentDeskDecision {
		const route = routeNewsroomRequest(command, {
			default_tool_budget: mergeToolBudget(options.default_tool_budget)
		});
		const role = roleForCommand(command, route);
		const payload: AssignmentDeskEventPayload = {
			command_excerpt: excerpt(command),
			routed_role: role,
			selected_mode: route.selected_mode,
			tools_to_use: route.tools_to_use,
			reason: route.reason,
			expected_output: route.expected_output
		};
		return {
			command,
			command_excerpt: payload.command_excerpt,
			role,
			route,
			event: {
				agent: 'assignment_desk',
				kind: 'assignment.triaged',
				payload
			}
		};
	}
}

function roleForCommand(command: string, route: RouteDecision): NewsroomRole {
	// Intent-driven monitoring requests keep their role-specific instructions;
	// everything else routes through the research desk.
	const desk = deskFromCommand(command);
	if (desk) return desk;
	return roleForRoute(route);
}

function deskFromCommand(command: string): NewsroomRole | null {
	const text = command.toLowerCase();
	if (/\b(monitor|watch|alert|track|changes?)\b/.test(text)) return 'monitoring';
	return null;
}

function roleForRoute(route: RouteDecision): NewsroomRole {
	switch (route.selected_mode) {
		case 'source_monitor':
		case 'web_search':
		case 'hybrid_research':
		case 'custom_tool':
		case 'browser_automation':
			return 'research';
		case 'clarification_needed':
		case 'answer_from_memory':
			return 'assignment_desk';
	}
}

function excerpt(value: string): string {
	const normalized = value.replace(/\s+/g, ' ').trim();
	if (normalized.length <= 180) return normalized;
	return `${normalized.slice(0, 179).trim()}…`;
}
