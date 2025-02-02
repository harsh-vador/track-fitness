import React, { useEffect, useState, useRef } from 'react';
import { StyleSheet, Text, View, Dimensions, Platform } from 'react-native';

import { Camera } from 'expo-camera';

import * as tf from '@tensorflow/tfjs';
import * as posedetection from '@tensorflow-models/pose-detection';
import * as ScreenOrientation from 'expo-screen-orientation';
import {
  bundleResourceIO,
  cameraWithTensors,
} from '@tensorflow/tfjs-react-native';
import Svg, { Circle } from 'react-native-svg';
import { ExpoWebGLRenderingContext } from 'expo-gl';
import { CameraType } from 'expo-camera/build/Camera.types';

// tslint:disable-next-line: variable-name
const TensorCamera = cameraWithTensors(Camera);

const IS_ANDROID = Platform.OS === 'android';
const IS_IOS = Platform.OS === 'ios';

// Camera preview size.
//
// From experiments, to render camera feed without distortion, 16:9 ratio
// should be used fo iOS devices and 4:3 ratio should be used for android
// devices.
//
// This might not cover all cases.
const CAM_PREVIEW_WIDTH = Dimensions.get('window').width;
const CAM_PREVIEW_HEIGHT = CAM_PREVIEW_WIDTH / (IS_IOS ? 9 / 16 : 3 / 4);

// The score threshold for pose detection results.
const MIN_KEYPOINT_SCORE = 0.3;

// The size of the resized output from TensorCamera.
//
// For movenet, the size here doesn't matter too much because the model will
// preprocess the input (crop, resize, etc). For best result, use the size that
// doesn't distort the image.
const OUTPUT_TENSOR_WIDTH = 180;
const OUTPUT_TENSOR_HEIGHT = OUTPUT_TENSOR_WIDTH / (IS_IOS ? 9 / 16 : 3 / 4);

// Whether to auto-render TensorCamera preview.
const AUTO_RENDER = false;

// Whether to load model from app bundle (true) or through network (false).
const LOAD_MODEL_FROM_BUNDLE = false;

export default function App() {
  const cameraRef = useRef(null);
  const [tfReady, setTfReady] = useState(false);
  const [model, setModel] = useState<posedetection.PoseDetector>();
  const [poses, setPoses] = useState<posedetection.Pose[]>();
  const [fps, setFps] = useState(0);
  const [orientation, setOrientation] =
    useState<ScreenOrientation.Orientation>();
  const [cameraType, setCameraType] = useState<CameraType>(
    Camera.Constants.Type.front
  );
  // Use `useRef` so that changing it won't trigger a re-render.
  //
  // - null: unset (initial value).
  // - 0: animation frame/loop has been canceled.
  // - >0: animation frame has been scheduled.
  const rafId = useRef<number | null>(null);

  useEffect(() => {
    async function prepare() {
      rafId.current = null;

      // Set initial orientation.
      const curOrientation = await ScreenOrientation.getOrientationAsync();
      setOrientation(curOrientation);

      // Listens to orientation change.
      ScreenOrientation.addOrientationChangeListener((event) => {
        setOrientation(event.orientationInfo.orientation);
      });

      // Camera permission.
      await Camera.requestCameraPermissionsAsync();

      // Wait for tfjs to initialize the backend.
      await tf.ready();

      // Load movenet model.
      // https://github.com/tensorflow/tfjs-models/tree/master/pose-detection
      const movenetModelConfig: posedetection.MoveNetModelConfig = {
        modelType: posedetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
        enableSmoothing: true,
      };
      if (LOAD_MODEL_FROM_BUNDLE) {
        const modelJson = require('./offline_model/model.json');
        const modelWeights1 = require('./offline_model/group1-shard1of2.bin');
        const modelWeights2 = require('./offline_model/group1-shard2of2.bin');
        movenetModelConfig.modelUrl = bundleResourceIO(modelJson, [
          modelWeights1,
          modelWeights2,
        ]);
      }
      const model = await posedetection.createDetector(
        posedetection.SupportedModels.MoveNet,
        movenetModelConfig
      );
      setModel(model);

      // Ready!
      setTfReady(true);
    }

    prepare();
  }, []);

  useEffect(() => {
    // Called when the app is unmounted.
    return () => {
      if (rafId.current != null && rafId.current !== 0) {
        cancelAnimationFrame(rafId.current);
        rafId.current = 0;
      }
    };
  }, []);

  const handleCameraStream = async (
    images: IterableIterator<tf.Tensor3D>,
    updatePreview: () => void,
    gl: ExpoWebGLRenderingContext
  ) => {
    const loop = async () => {
      // Get the tensor and run pose detection.
      const imageTensor = images.next().value as tf.Tensor3D;

      const startTs = Date.now();
      const poses = await model!.estimatePoses(
        imageTensor,
        undefined,
        Date.now()
      );
      const latency = Date.now() - startTs;
      setFps(Math.floor(1000 / latency));
      setPoses(poses);
      tf.dispose([imageTensor]);

      if (rafId.current === 0) {
        return;
      }

      // Render camera preview manually when autorender=false.
      if (!AUTO_RENDER) {
        updatePreview();
        gl.endFrameEXP();
      }

      rafId.current = requestAnimationFrame(loop);
    };

    loop();
  };

  const detectSquat = () => {
    // Create a dictionary for easy access
    const keypointsDict = {};
    const keypointsAgain = poses[0].keypoints;
    keypointsAgain?.forEach(kp => {
      keypointsDict[kp.name] = kp;
    });

    // Function to calculate angle between three points
    function calculateAngle(a, b, c) {
      /**
       * Calculates the angle at point B (in degrees) given three points A, B, and C.
       * Each point is an object with 'x' and 'y' properties.
       */
      const ba = { x: a.x - b.x, y: a.y - b.y };
      const bc = { x: c.x - b.x, y: c.y - b.y };

      // Calculate the dot product and magnitude of vectors
      const dotProduct = ba.x * bc.x + ba.y * bc.y;
      const magnitudeBA = Math.hypot(ba.x, ba.y);
      const magnitudeBC = Math.hypot(bc.x, bc.y);

      // Avoid division by zero
      if (magnitudeBA * magnitudeBC === 0) {
        return null;
      }

      // Calculate the angle in radians and then convert to degrees
      const angleRad = Math.acos(dotProduct / (magnitudeBA * magnitudeBC));
      const angleDeg = (angleRad * 180.0) / Math.PI;

      return angleDeg;
    }

    // Thresholds for squat detection
    const KNEE_ANGLE_THRESHOLD = 90;  // degrees
    const HIP_ANGLE_THRESHOLD = 120;  // degrees
    const MIN_SCORE_THRESHOLD = 0.2;  // Minimum confidence score for keypoints

    // Extract required keypoints (ensure they have a sufficient score)
    function getKeypoint(name) {
      const kp = keypointsDict[name];
      if (kp && kp.score >= MIN_SCORE_THRESHOLD) {
        return kp;
      } else {
        return null;
      }
    }

    // Get keypoints
    const left_hip = getKeypoint('left_hip');
    const left_knee = getKeypoint('left_knee');
    const left_ankle = getKeypoint('left_ankle');
    const left_shoulder = getKeypoint('left_shoulder');

    const right_hip = getKeypoint('right_hip');
    const right_knee = getKeypoint('right_knee');
    const right_ankle = getKeypoint('right_ankle');
    const right_shoulder = getKeypoint('right_shoulder');

    // Initialize variables
    let squatDetected = false;

    // Check left side
    if (left_hip && left_knee && left_ankle) {
      const left_knee_angle = calculateAngle(left_hip, left_knee, left_ankle);
      let left_hip_angle = null;
      if (left_shoulder) {
        left_hip_angle = calculateAngle(left_shoulder, left_hip, left_knee);
      }
      console.log(left_knee_angle, left_hip_angle);
      if (
        left_knee_angle !== null && left_knee_angle < KNEE_ANGLE_THRESHOLD &&
        left_hip_angle !== null && left_hip_angle < HIP_ANGLE_THRESHOLD
      ) {
        squatDetected = true;
      }
    }

    // Check right side
    if (right_hip && right_knee && right_ankle) {
      const right_knee_angle = calculateAngle(right_hip, right_knee, right_ankle);
      let right_hip_angle = null;
      if (right_shoulder) {
        right_hip_angle = calculateAngle(right_shoulder, right_hip, right_knee);
      }
      if (
        right_knee_angle !== null && right_knee_angle < KNEE_ANGLE_THRESHOLD &&
        right_hip_angle !== null && right_hip_angle < HIP_ANGLE_THRESHOLD
      ) {
        squatDetected = true;
      }
    }

    // Output result
    if (squatDetected) {
      console.log("Squat detected");
    } else {
      console.log("No squat detected");
    }}

    const detectPushUp = () => {


// Create a dictionary for easy access
const keypointsDict = {};
const keypoints = poses?.[0].keypoints;
keypoints?.forEach(kp => {
  keypointsDict[kp.name] = kp;
});

// Function to calculate angle between three points
function calculateAngle(a, b, c) {
  /**
   * Calculates the angle at point B (in degrees) given three points A, B, and C.
   * Each point is an object with 'x' and 'y' properties.
   */
  const ba = { x: a.x - b.x, y: a.y - b.y };
  const bc = { x: c.x - b.x, y: c.y - b.y };

  // Calculate the dot product and magnitude of vectors
  const dotProduct = ba.x * bc.x + ba.y * bc.y;
  const magnitudeBA = Math.hypot(ba.x, ba.y);
  const magnitudeBC = Math.hypot(bc.x, bc.y);

  // Avoid division by zero
  if (magnitudeBA * magnitudeBC === 0) {
    return null;
  }

  // Calculate the angle in radians and then convert to degrees
  const angleRad = Math.acos(dotProduct / (magnitudeBA * magnitudeBC));
  const angleDeg = (angleRad * 180.0) / Math.PI;

  return angleDeg;
}

// Thresholds for push-up detection
const ELBOW_ANGLE_THRESHOLD = 160;   // degrees (extended arm)
const BODY_ALIGNMENT_THRESHOLD = 20; // degrees (straight body)
const MIN_SCORE_THRESHOLD = 0.2;     // Minimum confidence score for keypoints

// Extract required keypoints (ensure they have a sufficient score)
function getKeypoint(name) {
  const kp = keypointsDict[name];
  if (kp && kp.score >= MIN_SCORE_THRESHOLD) {
    return kp;
  } else {
    return null;
  }
}

// Get keypoints
const left_shoulder = getKeypoint('left_shoulder');
const left_elbow = getKeypoint('left_elbow');
const left_wrist = getKeypoint('left_wrist');
const left_hip = getKeypoint('left_hip');
const left_knee = getKeypoint('left_knee');
const left_ankle = getKeypoint('left_ankle');

const right_shoulder = getKeypoint('right_shoulder');
const right_elbow = getKeypoint('right_elbow');
const right_wrist = getKeypoint('right_wrist');
const right_hip = getKeypoint('right_hip');
const right_knee = getKeypoint('right_knee');
const right_ankle = getKeypoint('right_ankle');

// Initialize variables
let pushupDetected = false;

// Function to check if body is aligned (plank position)
function isBodyAligned(shoulder, hip, ankle) {
  const angle = calculateAngle(shoulder, hip, ankle);
  if (angle !== null && Math.abs(angle - 180) < BODY_ALIGNMENT_THRESHOLD) {
    return true;
  } else {
    return false;
  }
}

// Check left side
if (left_shoulder && left_elbow && left_wrist && left_hip && left_knee && left_ankle) {
  const left_elbow_angle = calculateAngle(left_shoulder, left_elbow, left_wrist);
  const left_body_aligned = isBodyAligned(left_shoulder, left_hip, left_ankle);

  if (
    left_elbow_angle !== null && left_elbow_angle > ELBOW_ANGLE_THRESHOLD &&
    left_body_aligned
  ) {
    pushupDetected = true;
  }
}

// Check right side
if (right_shoulder && right_elbow && right_wrist && right_hip && right_knee && right_ankle) {
  const right_elbow_angle = calculateAngle(right_shoulder, right_elbow, right_wrist);
  const right_body_aligned = isBodyAligned(right_shoulder, right_hip, right_ankle);

  if (
    right_elbow_angle !== null && right_elbow_angle > ELBOW_ANGLE_THRESHOLD &&
    right_body_aligned
  ) {
    pushupDetected = true;
  }
}

// Output result
if (pushupDetected) {
  console.log("Push-up detected");
} else {
  console.log("No push-up detected");
}
    }

  const renderPose = () => {
    if (poses != null && poses.length > 0) {
      const keypoints = poses[0].keypoints
        .filter((k) => (k.score ?? 0) > MIN_KEYPOINT_SCORE)
        .map((k) => {
          // Flip horizontally on android or when using back camera on iOS.
          const flipX = IS_ANDROID || cameraType === Camera.Constants.Type.back;
          const x = flipX ? getOutputTensorWidth() - k.x : k.x;
          const y = k.y;
          const cx =
            (x / getOutputTensorWidth()) *
            (isPortrait() ? CAM_PREVIEW_WIDTH : CAM_PREVIEW_HEIGHT);
          const cy =
            (y / getOutputTensorHeight()) *
            (isPortrait() ? CAM_PREVIEW_HEIGHT : CAM_PREVIEW_WIDTH);
            detectSquat();
detectPushUp();
          return (
            <Circle
              key={`skeletonkp_${k.name}`}
              cx={cx}
              cy={cy}
              r='4'
              strokeWidth='2'
              fill='#00AA00'
              stroke='white'
            />
          );
        });

      return <Svg style={styles.svg}>{keypoints}</Svg>;
    } else {
      return <View></View>;
    }
  };

  const renderFps = () => {
    return (
      <View style={styles.fpsContainer}>
        <Text>FPS: {fps}</Text>
      </View>
    );
  };

  const renderCameraTypeSwitcher = () => {
    return (
      <View
        style={styles.cameraTypeSwitcher}
        onTouchEnd={handleSwitchCameraType}
      >
        <Text>
          Switch to{' '}
          {cameraType === Camera.Constants.Type.front ? 'back' : 'front'} camera
        </Text>
      </View>
    );
  };

  const handleSwitchCameraType = () => {
    if (cameraType === Camera.Constants.Type.front) {
      setCameraType(Camera.Constants.Type.back);
    } else {
      setCameraType(Camera.Constants.Type.front);
    }
  };

  const isPortrait = () => {
    return (
      orientation === ScreenOrientation.Orientation.PORTRAIT_UP ||
      orientation === ScreenOrientation.Orientation.PORTRAIT_DOWN
    );
  };

  const getOutputTensorWidth = () => {
    // On iOS landscape mode, switch width and height of the output tensor to
    // get better result. Without this, the image stored in the output tensor
    // would be stretched too much.
    //
    // Same for getOutputTensorHeight below.
    return isPortrait() || IS_ANDROID
      ? OUTPUT_TENSOR_WIDTH
      : OUTPUT_TENSOR_HEIGHT;
  };

  const getOutputTensorHeight = () => {
    return isPortrait() || IS_ANDROID
      ? OUTPUT_TENSOR_HEIGHT
      : OUTPUT_TENSOR_WIDTH;
  };

  const getTextureRotationAngleInDegrees = () => {
    // On Android, the camera texture will rotate behind the scene as the phone
    // changes orientation, so we don't need to rotate it in TensorCamera.
    if (IS_ANDROID) {
      return 0;
    }

    // For iOS, the camera texture won't rotate automatically. Calculate the
    // rotation angles here which will be passed to TensorCamera to rotate it
    // internally.
    switch (orientation) {
      // Not supported on iOS as of 11/2021, but add it here just in case.
      case ScreenOrientation.Orientation.PORTRAIT_DOWN:
        return 180;
      case ScreenOrientation.Orientation.LANDSCAPE_LEFT:
        return cameraType === Camera.Constants.Type.front ? 270 : 90;
      case ScreenOrientation.Orientation.LANDSCAPE_RIGHT:
        return cameraType === Camera.Constants.Type.front ? 90 : 270;
      default:
        return 0;
    }
  };

  if (!tfReady) {
    return (
      <View style={styles.loadingMsg}>
        <Text>Loading...</Text>
      </View>
    );
  } else {
    return (
      // Note that you don't need to specify `cameraTextureWidth` and
      // `cameraTextureHeight` prop in `TensorCamera` below.
      <View
        style={
          isPortrait() ? styles.containerPortrait : styles.containerLandscape
        }
      >
        <TensorCamera
          ref={cameraRef}
          style={styles.camera}
          autorender={AUTO_RENDER}
          type={cameraType}
          // tensor related props
          resizeWidth={getOutputTensorWidth()}
          resizeHeight={getOutputTensorHeight()}
          resizeDepth={3}
          rotation={getTextureRotationAngleInDegrees()}
          onReady={handleCameraStream}
        />
        {renderPose()}
        {renderFps()}
        {renderCameraTypeSwitcher()}
      </View>
    );
  }
}

const styles = StyleSheet.create({
  containerPortrait: {
    position: 'relative',
    width: CAM_PREVIEW_WIDTH,
    height: CAM_PREVIEW_HEIGHT,
    marginTop: Dimensions.get('window').height / 2 - CAM_PREVIEW_HEIGHT / 2,
  },
  containerLandscape: {
    position: 'relative',
    width: CAM_PREVIEW_HEIGHT,
    height: CAM_PREVIEW_WIDTH,
    marginLeft: Dimensions.get('window').height / 2 - CAM_PREVIEW_HEIGHT / 2,
  },
  loadingMsg: {
    position: 'absolute',
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  camera: {
    width: '100%',
    height: '100%',
    zIndex: 1,
  },
  svg: {
    width: '100%',
    height: '100%',
    position: 'absolute',
    zIndex: 30,
  },
  fpsContainer: {
    position: 'absolute',
    top: 10,
    left: 10,
    width: 80,
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, .7)',
    borderRadius: 2,
    padding: 8,
    zIndex: 20,
  },
  cameraTypeSwitcher: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 180,
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, .7)',
    borderRadius: 2,
    padding: 8,
    zIndex: 20,
  },
});
