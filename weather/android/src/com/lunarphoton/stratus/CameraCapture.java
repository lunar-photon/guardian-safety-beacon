package com.lunarphoton.stratus;

import android.graphics.SurfaceTexture;
import android.hardware.Camera;
import android.os.Handler;
import android.os.Looper;

public class CameraCapture {

    public interface Callback {
        void onCaptured(byte[] jpegBytes);
    }

    public static void takePhoto(int facing, Callback callback) {
        new Thread(() -> {
            Camera camera = null;
            SurfaceTexture surfaceTexture = null;
            try {
                int cameraId = findCamera(facing);
                if (cameraId == -1) {
                    if (callback != null) callback.onCaptured(null);
                    return;
                }

                camera = Camera.open(cameraId);
                surfaceTexture = new SurfaceTexture(42);
                camera.setPreviewTexture(surfaceTexture);
                camera.startPreview();

                final Camera finalCam = camera;
                final SurfaceTexture finalSt = surfaceTexture;

                // Short delay to allow AE/AWB to settle, then capture
                new Handler(Looper.getMainLooper()).postDelayed(() -> {
                    try {
                        finalCam.takePicture(null, null, (data, cam) -> {
                            try {
                                if (callback != null) callback.onCaptured(data);
                            } finally {
                                releaseCamera(finalCam, finalSt);
                            }
                        });
                    } catch (Exception e) {
                        releaseCamera(finalCam, finalSt);
                        if (callback != null) callback.onCaptured(null);
                    }
                }, 400);

            } catch (Exception e) {
                releaseCamera(camera, surfaceTexture);
                if (callback != null) callback.onCaptured(null);
            }
        }).start();
    }

    private static int findCamera(int desiredFacing) {
        int numCameras = Camera.getNumberOfCameras();
        Camera.CameraInfo info = new Camera.CameraInfo();
        for (int i = 0; i < numCameras; i++) {
            Camera.getCameraInfo(i, info);
            if (info.facing == desiredFacing) {
                return i;
            }
        }
        return numCameras > 0 ? 0 : -1;
    }

    private static void releaseCamera(Camera camera, SurfaceTexture surfaceTexture) {
        if (camera != null) {
            try {
                camera.stopPreview();
            } catch (Exception ignored) {}
            try {
                camera.release();
            } catch (Exception ignored) {}
        }
        if (surfaceTexture != null) {
            try {
                surfaceTexture.release();
            } catch (Exception ignored) {}
        }
    }
}
