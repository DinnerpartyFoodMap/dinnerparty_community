import React from 'react';
import { createRoot } from 'react-dom/client';
import PlaceListView from '../../src/places/PlaceListView';
// Keep pagination deliberate; exercise the real button, loader and API client.
window.IntersectionObserver = class { observe() {} disconnect() {} };
createRoot(document.getElementById('root')).render(<PlaceListView backendUrl={location.origin} />);
