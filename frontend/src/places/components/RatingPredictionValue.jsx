import React from 'react';
import { formatAverage } from '../rating.js';

export default function RatingPredictionValue({ average }) {
    return (
        <strong style={{ color: 'var(--color-text-primary)', fontSize: 'var(--text-headline-size)', fontVariantNumeric: 'tabular-nums' }}>
            {formatAverage(average)}
        </strong>
    );
}
