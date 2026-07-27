# calendar-bridge — agent guide

Deadline/meeting features emit .ics via ics.event and serve it as
text/calendar — works with Outlook/Google without OAuth. Times are ISO UTC in,
ICS UTC out; never emit floating local times.
