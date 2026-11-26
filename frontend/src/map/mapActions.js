// Pointer, keyboard, native selections and programmatic modes share one owner.
export function createMapActionGate(readContext) {
    let sequence=0;
    return {
        capture() {return {...readContext(),sequence:++sequence};},
        invalidate() {sequence++;},
        select(commit) {sequence++;return commit();},
        refresh(ticket) { return this.isCurrent(ticket,{data:false}) ? {...ticket,...readContext()} : null; },
        isCurrent(ticket,{data=true} = {}) {
            if (!ticket) return false;
            const current=readContext();
            return ticket.sequence===sequence && ticket.map===current.map && ticket.layer===current.layer
                && ticket.mode===current.mode && (!data || (ticket.dataRevision===current.dataRevision
                && ticket.targetRevision===current.targetRevision));
        }
    };
}

export async function focusExhibitionVenue(place,{select,isSelected,showMarker}) {
    const opened=await select(place);
    if (opened && isSelected(place)) showMarker(place);
    return opened;
}
