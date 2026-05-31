interface CalendarParams {
    calendar_names?: string[];
    start_date?: string;
    end_date?: string;
    title?: string;
    location?: string;
    description?: string;
}
interface CalendarAction {
    op: 'list_calendars' | 'list_events' | 'create_event';
    params?: CalendarParams;
}
interface CalendarEvent {
    title: string;
    start: string;
    end: string;
    calendar: string;
    location: string;
    description: string;
}
interface CalendarSummary {
    name: string;
}
export declare function listCalendars(): Promise<CalendarSummary[]>;
export declare function listEvents(params: CalendarParams): Promise<CalendarEvent[]>;
export declare function createEvent(params: CalendarParams): Promise<{
    status: string;
    title: string;
}>;
export declare function handleAction(action: CalendarAction): Promise<unknown>;
export {};
//# sourceMappingURL=index.d.ts.map