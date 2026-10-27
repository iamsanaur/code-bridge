import { Alert, Platform } from 'react-native';

/** Destructive-action confirmation that works on native and in the web preview. */
export function confirmAction(title: string, message: string, confirm: string): Promise<boolean> {
  if (Platform.OS === 'web')
    return Promise.resolve(globalThis.confirm?.(`${title}\n\n${message}`) ?? false);
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: confirm, style: 'destructive', onPress: () => resolve(true) },
    ]),
  );
}
