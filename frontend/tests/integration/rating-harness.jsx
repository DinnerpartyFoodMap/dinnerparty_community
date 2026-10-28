import React from 'react';
import {createRoot} from 'react-dom/client';
import {MotionProvider} from '../../src/motion/MotionProvider';
import {OverlayHost} from '../../src/components/overlay/OverlayHost';
import PlaceRatingPanel from '../../src/places/components/PlaceRatingPanel';
import usePlaceRating from '../../src/places/hooks/usePlaceRating';
import '../../src/styles/tokens.css';
window.__TEST_TIPS=[];
function Harness(){
    const rating=usePlaceRating({backendUrl:location.origin,token:window.__TEST_TOKEN,placeId:1});
    return <><output id="rating-state">{JSON.stringify(rating.data)}</output><PlaceRatingPanel open place={{id:1,name:'评分回归地点'}} rating={rating} isAuthenticated onClose={()=>{}} showTip={tip=>window.__TEST_TIPS.push(tip)}/></>;
}
createRoot(document.getElementById('root')).render(<MotionProvider><OverlayHost><Harness/></OverlayHost></MotionProvider>);
