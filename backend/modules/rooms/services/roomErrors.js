class RoomError extends Error {
    constructor(status, code, message, errors) {
        super(message);
        this.status = status;
        this.code = code;
        this.publicMessage = message;
        this.errors = errors;
    }
}

function roomNotFound() {
    return new RoomError(404, 'room_not_found', '找不到小伙伴页面');
}

module.exports = { RoomError, roomNotFound };
